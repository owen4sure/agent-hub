# Agent Hub 🤖

[![CI](https://github.com/owen4sure/agent-hub/actions/workflows/ci.yml/badge.svg)](https://github.com/owen4sure/agent-hub/actions/workflows/ci.yml)

[繁體中文](./README.zh-TW.md) | **English**

A local-first visual workflow automation platform — **like n8n**, your task becomes a graph of nodes on a canvas, but **you build and modify everything by chatting with AI in plain language. You never write or read code.**

![Workflow canvas: node graph on the left, plain-language AI chat on the right](docs/screenshots/canvas.png)

> The product UI is currently in Traditional Chinese. The screenshots below show the real product; captions explain what you're looking at.

## Core ideas

- **A workflow is a node graph**: every step is visible on the canvas (login → find email → download → process → save), and data flows between nodes.
- **Built by talking**: describe what you want in the AI chat panel → the AI asks clarifying questions first → then draws the node graph for you.
- **Reliable building blocks + an escape hatch**: login, email search, downloads, Excel, HTTP calls, conditions, AI decisions… are all pre-tested blocks. Only when no block fits does the AI write a "custom code" node — and you still never have to read the code.
- **Self-hosted, per person**: clone and run it on your own machine. Credentials and API keys live only in your local `data/` directory (gitignored).

## Quick start

```bash
npm install          # postinstall also downloads Playwright's Chromium
npm run doctor        # health check: Node version / browser / folder permissions, with fix instructions
npm run dev
```

Open http://127.0.0.1:3000 (bound to localhost only — other devices can't reach it).

> Using an AI coding tool like Claude Code? Just paste this repo's URL into it — following `AGENTS.md`, it will set up the environment, run the health check, and verify the app opens, no commands needed on your side.

1. On the **Settings** page, enter your model **API Key / Base URL** (any OpenAI-compatible endpoint), or set the environment variables `AGENT_HUB_API_KEY` / `AGENT_HUB_BASE_URL` (see `.env.example`). Credentials your workflows need (e.g. webmail) also go on the Settings page.
   - **Automatic fallback**: if this machine has Claude Code installed and logged in (the `claude` command works), then when your primary model (often a free/shared API) keeps failing after retries, Agent Hub **automatically** falls back to the local Claude Code CLI (using your Claude subscription) — flaky free services no longer take the whole workflow down. You can also pick "claude-code (local subscription)" as your primary model in the model dropdown.
2. From the home page, click **＋ New workflow** to enter the canvas, then tell the AI what you want in the right-hand panel.
3. The AI asks about details first, and only draws the node graph once everything is clear → you click **Apply** → the flow appears on the canvas.
4. Click **▶ Run**: each node lights up in real time as execution progresses. Click any node to inspect the data flowing through it, tweak it in plain language, or have the AI fix it when it fails.

![A live run: nodes light up in real time — green means done, amber means running](docs/screenshots/run-live.png)

## Building flows in plain language

- **Build**: describe your need in the chat panel (you can upload screenshots/documents to help the AI understand). If anything is unclear, the AI asks before drawing → you confirm and apply.
- **Tweak one step**: click a node on the canvas → say "search for the XX email instead" → the AI edits just that node.
- **Self-repair on failure**: a node turns red → click "🔧 Let AI fix this step" → the AI reads the error and page screenshot and proposes a fix.
- **Add/remove steps**: tell the AI "add an email-sending step at the end" or "drop the notification step".

![A failed node turns red: the error message is in plain words, with a one-click "Let AI fix this step"](docs/screenshots/ai-fix.png)

## Built-in example: monthly inventory Excel digest

Shows how one task splits into 5 nodes: start → log in to webmail (the image CAPTCHA is read by a vision model automatically) → find the exact email by date + report name → download the attachment → filter an Excel date range, highlight rows, save a new file. Duplicate it and adapt it to your own task. Date parameters support relative tokens (`{{yesterday}}`, `{{last-quarter-start}}`) that resolve to concrete dates at trigger time; before each run you pick the accounting period and all dates are computed for you to confirm.

![Pre-run form: pick the period — filter range, report date, and output filename are all computed automatically](docs/screenshots/run-form.png)

## Node library (extensible)

Triggers, browser (login / find email / download attachment), data (Excel / string templates / PDF reading / zip extraction), integrations (HTTP requests), logic (conditions / variables), AI (decide / generate), and custom code. Each node type is one file in `lib/workflow/nodes/*.ts` — add a file and the AI can use it immediately. Files uploaded to the AI (PDF, Word `.docx/.doc`, Excel `.xlsx/.xls`, PowerPoint `.pptx`, RTF, plain-text family) are converted to text server-side (`lib/textExtract.ts`); images and screenshots go through a vision model that truly *sees* the content (Excel colors/borders/layout, embedded charts, web pages) — not just extracted text.

## Scheduling

Set a schedule per workflow (daily / monthly / quarterly on Jan-Apr-Jul-Oct / weekly / raw cron) and the whole graph triggers automatically (headless). Requires the engine running as a daemon:

```bash
scripts/install-daemon.sh     # launchd daemon, starts on boot (macOS)
scripts/uninstall-daemon.sh
```

![Schedule dialog: settings are echoed back in plain words — "every quarter (Jan, Apr, Jul, Oct) on the 1st at 9:00 AM"](docs/screenshots/schedule.png)

**Schedules don't fire while the computer is off or asleep** (an inherent limit of local-first).

**Failed scheduled runs come with a fix, pre-baked**: when a production workflow fails on schedule, you get a desktop notification while the AI works out a repair in the background. Open the home page, see the "AI has a fix ready" card, click "✅ Apply & re-run" — no debugging on your side. Applying auto-backs-up first; you can always restore from the workflow's Versions panel.

## Export / import (sharing with colleagues)

A workflow exports to a single `.agenthub-workflow.json` (credentials excluded). A colleague imports it as a draft and just fills in their own credentials.

## Repository layout

```
app/workflows/[id]/     ★ canvas + AI chat (main screen)
app/{,drafts,files,settings,schedules}/
lib/workflow/
  types.ts registry.ts        node contract + node library registry
  engine.ts                    execution engine (topological run / shared browser / retry / crash recovery)
  builder.ts nodeEditor.ts     AI graph building (clarify-first) / AI node editing
  repair.ts                    shared repair logic for autofix (one node) and autorun (test drafts until they pass)
  fixProposals.ts              background fix proposals for failed scheduled runs (one-click apply & re-run)
  learnedFixes.ts              remembered fixes, applied directly when similar errors recur
  explain.ts                   translates the whole graph into plain-language steps
  store.ts                     workflows stored as data/workflows/*.json, with version backup/restore (history/)
  nodes/*.ts                   one file per node type
lib/aiRetry.ts                 model-call retry (backoff + empty responses count as failures) + Claude Code fallback
lib/claudeCodeClient.ts        when all free models fail, falls back to the local claude CLI
lib/textExtract.ts             server-side text extraction for uploaded files (Excel/PDF/Word/RTF)
lib/scheduler.ts               scheduling (cron matching / next_run_at / catch-up runs)
lib/notify.ts                  desktop notifications for schedule success/failure (macOS)
examples/                      built-in example workflows (read-only)
data/                          local state (gitignored): DB, workflows, debug screenshots, output files
docs/ARCHITECTURE_V2.md        the original design document (partially outdated; code and this README win)
```

## Development

```bash
npm run test    # unit tests for core logic (relative-date resolution, graph lint, JSON extraction, cron — pure functions)
npm run lint    # ESLint
```

## Security

- **No keys in code**: read from `.env` (`AGENT_HUB_API_KEY`, gitignored) or the Settings page; never committed.
- `data/` is fully gitignored; credentials are stored in plaintext in local SQLite (same trust model as a browser's saved passwords) — don't sync it to the cloud.
- The AI always shows a preview for you to confirm before building or editing the graph, and auto-backups make everything restorable.
- Built-in examples are read-only; duplicate before editing.
- **This is a single-user local tool, bound to `127.0.0.1` by default** (`npm run dev` / `npm run start` both pass `-H 127.0.0.1`). **Do not change it to `-H 0.0.0.0` or host it publicly** — the `custom-code` node (AI-written custom steps) and the `http-request` node execute code / reach arbitrary URLs on your machine, so exposing them is equivalent to RCE/SSRF.
- **Built-in cross-site protection** (`proxy.ts`): binding to 127.0.0.1 alone can't stop a malicious web page from making your own browser send requests to localhost. All `/api` requests verify the Host header (against DNS rebinding), and non-GET requests additionally require a local Origin — cross-site requests from external sites get 403.
- **The `custom-code` node runs AI-generated code on your machine with your user permissions** — that's the nature of the "AI writes a custom step for you" feature. The code is visible before you apply it; if a workflow doesn't feel trustworthy, don't use custom-code nodes in it.
- **Model fallback**: your configured (often free) API is primary; only when the whole retry chain fails does the local Claude Code CLI step in once (see `lib/aiRetry.ts`) — it's not called on every request and incurs no surprise costs.
- License: MIT (see `LICENSE`).
