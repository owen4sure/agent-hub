/**
 * 資料保留期限：讓「多久以前的東西會被刪掉」變成一條看得到、設得動、會自己執行的規則。
 *
 * 先講清楚**原本已經有什麼**(避免重複做，也避免誤以為原本是無界成長)：
 * engine.ts 的 `pruneRuns()` 每次執行完會把「每條流程最近 20 筆之外」的執行紀錄連同
 * node_runs / run_logs / run_files / repeat_item_checkpoints、`data/runs/<id>`(除錯截圖與頁面 HTML)、
 * `data/outputs/<id>`(產出檔)一起刪掉。所以磁碟本來就有上限，不是無限長大。
 *
 * 但「筆數上限」回答不了保留**期限**的問題，而那才是資料保護真正在問的：
 * 一條每月只跑一次的流程，最近 20 筆等於**快兩年**的登入後截圖、客戶名單、財務數字留在磁碟上。
 * 筆數上限跟時間上限是兩個不同的控制項，這個模組補的是後者。
 *
 * 預設值刻意不對稱，理由是「刪錯東西的代價不一樣」：
 * - 除錯用的截圖/頁面 HTML：預設 90 天。這是 PII 最密集的地方(登入後的畫面)，而它的用途
 *   只有「查最近一次為什麼失敗」，90 天前的完全沒有價值。
 * - 執行紀錄與產出檔：**預設不啟用**(0 = 不按時間刪，仍受既有的 20 筆上限管)。
 *   那些是使用者的成果與軌跡，我不會替他決定要丟掉——要開由他自己開。
 */

import fs from "node:fs";
import path from "node:path";
import { getDb } from "./db";

export interface RetentionPolicy {
  /** 除錯截圖/頁面 HTML 保留天數(0 = 不按時間刪) */
  debugArtifactDays: number;
  /** 執行紀錄(含產出檔)保留天數(0 = 不按時間刪，只受既有的每流程 20 筆上限管) */
  runRecordDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = { debugArtifactDays: 90, runRecordDays: 0 };
const MAX_DAYS = 3_650;

function clampDays(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), MAX_DAYS);
}

export function getRetentionPolicy(): RetentionPolicy {
  const row = getDb().prepare(`SELECT value FROM settings WHERE key = 'retentionPolicy'`).get() as { value: string } | undefined;
  if (!row) return { ...DEFAULT_RETENTION };
  try {
    const parsed = JSON.parse(row.value) as Partial<RetentionPolicy>;
    return {
      debugArtifactDays: clampDays(parsed.debugArtifactDays, DEFAULT_RETENTION.debugArtifactDays),
      runRecordDays: clampDays(parsed.runRecordDays, DEFAULT_RETENTION.runRecordDays),
    };
  } catch {
    return { ...DEFAULT_RETENTION };
  }
}

export function setRetentionPolicy(input: Partial<RetentionPolicy>): RetentionPolicy {
  const current = getRetentionPolicy();
  const next: RetentionPolicy = {
    debugArtifactDays: clampDays(input.debugArtifactDays ?? current.debugArtifactDays, current.debugArtifactDays),
    runRecordDays: clampDays(input.runRecordDays ?? current.runRecordDays, current.runRecordDays),
  };
  getDb()
    .prepare(`INSERT INTO settings (key, value) VALUES ('retentionPolicy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(JSON.stringify(next));
  return next;
}

export interface RetentionSweepResult {
  debugDirsRemoved: number;
  runsRemoved: number;
  /** 只算，不刪(給畫面先讓使用者看清楚會刪掉什麼再決定) */
  preview: boolean;
}

function dataPath(...parts: string[]): string {
  return path.join(process.cwd(), "data", ...parts);
}

function cutoffIso(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * 執行(或預覽)一次保留期限清理。
 *
 * `preview: true` 時完全不動任何檔案或資料列，只回「會刪幾個」——這是刻意的：
 * 刪除是不可逆的，使用者按下去之前必須先看得到後果(而不是按完才發現刪掉了要用的東西)。
 */
export function sweepRetention(opts: { preview?: boolean } = {}): RetentionSweepResult {
  const preview = opts.preview === true;
  const policy = getRetentionPolicy();
  const db = getDb();
  const result: RetentionSweepResult = { debugDirsRemoved: 0, runsRemoved: 0, preview };

  // ① 除錯檔(data/runs/<runId>)：只刪檔案，執行紀錄本身留著。
  // 使用者仍然看得到「那次跑了什麼、哪一步失敗」，只是沒有截圖可以看——這是刻意的取捨：
  // 文字紀錄很小、對追溯有用；截圖與整頁 HTML 又大又敏感，過期價值趨近於零。
  if (policy.debugArtifactDays > 0) {
    const cutoff = cutoffIso(policy.debugArtifactDays);
    const stale = db
      .prepare(`SELECT id FROM runs WHERE status IN ('success','failed','stopped') AND started_at < ?`)
      .all(cutoff) as { id: string }[];
    for (const { id } of stale) {
      const dir = dataPath("runs", id);
      if (!fs.existsSync(dir)) continue;
      result.debugDirsRemoved++;
      if (!preview) fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ② 執行紀錄整筆(含產出檔)。絕不能碰 running/queued/waiting 的 run——
  // 執行到一半紀錄被砍會讓後續 UPDATE 變成空操作，那次執行最後會被誤判失敗(engine 的 pruneRuns
  // 也是為此只挑已結束的)。
  if (policy.runRecordDays > 0) {
    const cutoff = cutoffIso(policy.runRecordDays);
    const stale = db
      .prepare(`SELECT id FROM runs WHERE status IN ('success','failed','stopped') AND started_at < ?`)
      .all(cutoff) as { id: string }[];
    for (const { id } of stale) {
      result.runsRemoved++;
      if (preview) continue;
      db.prepare(`DELETE FROM repeat_item_checkpoints WHERE run_id = ?`).run(id);
      db.prepare(`DELETE FROM node_runs WHERE run_id = ?`).run(id);
      db.prepare(`DELETE FROM run_logs WHERE run_id = ?`).run(id);
      db.prepare(`DELETE FROM run_files WHERE run_id = ?`).run(id);
      db.prepare(`DELETE FROM runs WHERE id = ?`).run(id);
      fs.rmSync(dataPath("runs", id), { recursive: true, force: true });
      fs.rmSync(dataPath("outputs", id), { recursive: true, force: true });
    }
  }

  return result;
}

const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let lastSweep = 0;

/** 排程 tick 每分鐘會呼叫，這裡自己節流成一天一次。 */
export function sweepRetentionDaily(): void {
  const now = Date.now();
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  const result = sweepRetention();
  if (result.debugDirsRemoved > 0 || result.runsRemoved > 0) {
    console.log(`[retention] 清理過期資料：除錯檔 ${result.debugDirsRemoved} 份、執行紀錄 ${result.runsRemoved} 筆`);
  }
}
