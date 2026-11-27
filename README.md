# Antigravity Context Monitor

English | [简体中文](README.zh-CN.md)

A lightweight Antigravity 2.0 Sidecar UI plugin (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) that tracks real-time context window consumption, 9-category prompt breakdown + Top 5 largest items, Prompt Cache hit rate, TTFT / TPS speed, scope-based token & API cost attribution, 5h/7d quota burn-rate runway + AI credits, conversation switching (`Lock to Main Agent`), and a 16-week activity heatmap in the right-side auxiliary pane.

## Features

- **EN | 中文 Language Switcher**: Instant client-side bilingual toggle (`i18n.js`, default English) with zero host patching.
- **Conversation Switcher & Lock to Main Agent**: Switch tracked conversations directly from the sidecar or toggle **Lock Main** so subagent bursts never hijack the active main session gauge.
- **5h & 7d Model Quotas + Burn-Rate Runway & AI Credits**: Displays Gemini and Claude/GPT quota pools with countdowns, SQLite-backed burn-rate runway estimates (`Safe · X%/h` vs estimated exhaustion time), and `availableCredits`.
- **DSH-Style Scope Switcher & API Cost Attribution (`Active | Project | 7d | 30d | All`)**:
  - Incremental byte-offset SQLite scanner (`node:sqlite`, zero external DB binaries) indexing `transcript.jsonl` without re-parsing unchanged files or frozen months.
  - Bordered high-contrast Token & API Cost pills, **Models / Projects (nested chats) / Chats** breakdown modes, Currency FX + Plan ROI tracking, and editable custom API pricing (`$/1M`).
  - **Monthly Archive Export & Freeze**: Export any month's ledger as JSON and freeze closed sessions so historical months are never rescanned, plus one-click JSON re-import for historical viewing.
- **Multi-Account Status, All-Model Rates & Per-Model `5h / 7d` Quotas (`Accounts` Tab)**: Tracks active/cached account tokens and API rate values, collapsible per-account models, global **All Models & API Rates**, and **Per-Model Quotas (`5h & 7d`)**.
- **Dynamic Context Window Gauge + 9-Category Breakdown**: Tracks live context occupancy (`512K` compaction threshold vs `1M` native limit + compaction history), a 9-category stacked breakdown bar + Top 5 largest items, and one-click **Copy `/context`** / **Copy Handoff** buttons.
- **Hide / Show Any Section (`Sections`)**: Completely hide unused panels (`0` background RPCs/scans when hidden).
- **Theme Contrast Parity**: Automatically syncs with Antigravity Light and Dark theme variables with high-contrast WCAG-tuned badges and compact density.
- **16-Week SQLite Activity & Cost Heatmap**: Dedicated daily heatmap across Antigravity desktop and `agy` CLI (`~/.gemini/*/brain`) with `Tokens / $ Cost` toggle, `All / App / CLI` filter, streak counters, and `7d / 30d / Year` summaries.

## Architecture & Future Go Migration Note

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the endpoint/data-flow map.

- **Current Runtime (`Alpha 2` — Lightweight Node.js Sidecar)**: Zero external npm dependencies; runs on Node.js built-ins + Antigravity's `sidecar_sdk` + built-in `node:sqlite` (~80–95 MB process RSS vs ~580–650 MB for Chromium/Electron multi-tab webview dashboards).
- **Planned Future Consideration (Go Backend)**: Because all frontend assets in `sidecars/context_monitor/public/` are pure framework-free vanilla HTML/CSS/JS talking over clean JSON REST routes (`/api/context`, `/api/quotas`, `/api/scope`, `/api/breakdown`, `/api/conversations`, `/api/pricing`, `/api/archive/*`, `/api/heatmap`), the backend sidecar can optionally be ported to a standalone **Go** HTTP binary (`~8–18 MB` RAM) in a future milestone without changing any UI code or `app.asar`.

## Installation

### Option 1: Install from GitHub via `agy`

```bash
agy plugin install Mostakim2005/antigravity-context-monitor
```

### Option 2: Local Clone & Symlink

```bash
git clone https://github.com/Mostakim2005/antigravity-context-monitor.git
cd antigravity-context-monitor
ln -s "$(pwd)" ~/.gemini/config/plugins/antigravity-context-monitor
```

Validate plugin structure:

```bash
agy plugin validate ~/.gemini/config/plugins/antigravity-context-monitor --strict
```

## Development & Tests

```bash
cd sidecars/context_monitor
node --test test/*.test.mjs
```

## Community

Thanks to [jule-x](https://github.com/jule-x/antigravity-context-monitor) for the original sidecar monitor and the [LINUX DO](https://linux.do/) community.

## License

MIT
