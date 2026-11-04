"use client";

import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";

/**
 * 自訂連接線:分支標籤畫成藥丸、線中點有「＋」——點了直接在這條線中間插一步(n8n 同款體驗)。
 * 顏色/發光交給 globals.css 的 edge-main/edge-error/edge-ok(依 className,主題自適應)。
 */
export function WFEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data } = props;
  const d = (data ?? {}) as { label?: string; onInsert?: () => void; labelTone?: "error" | "ok" | "plain" };
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });

  const toneColor = d.labelTone === "error" ? "var(--red)" : d.labelTone === "ok" ? "var(--green)" : "var(--edge-label)";

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} />
      <EdgeLabelRenderer>
        <div
          style={{ position: "absolute", transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: "all" }}
          className="flex flex-col items-center gap-1 nodrag nopan"
        >
          {d.label && (
            <span
              className="px-2 py-0.5 rounded-full text-[10.5px] font-semibold whitespace-nowrap"
              style={{ background: "var(--edge-label-bg)", color: toneColor, border: "1px solid var(--border-strong)", boxShadow: "var(--shadow-sm)" }}
            >
              {d.label}
            </span>
          )}
          {d.onInsert && (
            <button
              onClick={(e) => { e.stopPropagation(); d.onInsert!(); }}
              title="在這條線中間插一步"
              className="wf-edge-plus grid place-items-center w-[22px] h-[22px] rounded-full text-[13px] leading-none transition-all"
              style={{
                background: "var(--menu-bg)",
                color: "var(--accent)",
                border: "1px solid var(--border-strong)",
                boxShadow: "var(--shadow-sm)",
                opacity: 0.55,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.transform = "scale(1.15)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.55"; e.currentTarget.style.transform = "scale(1)"; }}
            >
              ＋
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const edgeTypes = { wf: WFEdge };
