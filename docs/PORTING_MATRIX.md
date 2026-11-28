# Upstream Feature Parity & Architecture Matrix

Living tracker comparing upstream **`AGI-is-going-to-arrive/Antigravity-Context-Window-Monitor` (`v1.17.11`)** against our lightweight fork **`Mostakim2005/antigravity-context-monitor` (`Context`)**.  
Whenever either repository ships new capabilities, diff against this matrix to port architectural intent cleanly **without** reintroducing monolithic JSON state churn or background polling bloat.

---

### [DECISION: Four-Tab-Plus-SQLite-Architecture] | Aliases: parity plan, roadmap, bravo 2, accounts, memory budget
> **1-Line Summary:** `[DECIDED BY: HUMAN]` Organize `Context` around 4 hideable tabs (**Session** | **Cost** | **Accounts** | **Heatmap**) backed by `node:sqlite`, tracking per-account total token usage while keeping sidecar Private RAM near ~80–95 MB and idle CPU near 0%.

* **Why `Antigravity-Context-Window-Monitor` bloated to `638 MB – 1.67 GB`:** Rewrote a `~40 MB` monolithic `state-v1.json` every 30s (`durable-state.ts` 3-way `deepClone` + `JSON.stringify`), cached `8` full HTML tab snapshots (`snapshotCache`), retained full cross-chat call histories (`gmDetailedSummary`), and polled all historical trajectories every `5s`.
* **Our Hard Rules:**
  1. Never persist verbose step dumps in JSON; persist normalized counters & cursors in `node:sqlite`.
  2. Never poll inactive tabs or hidden sections (`CM_SECTIONS.isEnabled(...)` = `0` RPCs when hidden).
  3. Re-read transcripts incrementally via byte-offset cursors (`scanTranscriptIncremental`) and skip frozen archived months (`archived = 1`).
* **Links:** `[SUBSYSTEM: Lightweight-Sidecar-Core]`, `[DECISION: Node-Sqlite-Now-Go-Backend-Future]`

---

### [FEATURE: Parity-Inventory-Ledger] | Aliases: upstream diff, features, ported, planned, skipped
> **1-Line Summary:** Feature-by-feature status matrix tracking upstream `v1.17.11` modules vs our lightweight `Context` implementations.

| Feature | Upstream Origin (`Antigravity-Context-Window-Monitor`) | Status in `Context` | Lightweight Implementation (`Code Anchors`) | Memory / CPU Notes |
| --- | --- | --- | --- | --- |
| Bilingual EN / 中文 Toggle | `src/i18n-core.ts` | **Ported** | `sidecars/context_monitor/public/i18n.js :: CM_I18N` | Zero hover popovers; client overlay |
| Hide / Show Every Section & Tab | *(Fork Exclusive)* | **Ported** | `sidecars/context_monitor/public/sections.js :: CM_SECTIONS`, `public/prefs.js :: CM_PREFS` & `db.mjs :: saveUiPrefs` | Exact verbatim card titles; 0 work when hidden; persisted in SQLite `kv` + cross-install JSON mirror across restarts & disable/enable |
| Chat Switcher + Lock to Main Agent | `src/conversation-selector.ts` | **Ported** | `sidecars/context_monitor/main.mjs :: getConversationsSnapshot` & `public/extras.js` | Single LS metadata call (10s TTL) |
| 5h / 7d Model Quotas + Runway + AI Credits | `src/quota-runway.ts`, `src/account-credits.ts` | **Ported** | `sidecars/context_monitor/quotas.mjs` & `db.mjs :: recordQuotaSamplesAndComputeRunway` | 45m SQLite sliding samples (`<1 KB`) |
| 9-Category Context Breakdown + Top 5 | `src/context-breakdown.ts` | **Ported** | `sidecars/context_monitor/breakdown.mjs :: computeContextBreakdown` | Active chat only; step fallback fixed in Phase 1 |
| Incremental Usage & API Cost (`Cost` Tab + Monthly Freeze) | `src/daily-ledger.ts`, `src/pricing-store.ts` | **Ported (Phase 2)** | `sidecars/context_monitor/db.mjs :: scanTranscriptIncremental` & `pricing.mjs` | Moved into dedicated **Cost** tab (`#view-cost`) with scope switcher, price editor & JSON monthly freeze |
| 4-Tab Navigation (`Session` / `Cost` / `Accounts` / `Heatmap`) | *(Bravo 2 Ergonomic Layout)* | **Ported (Phase 2)** | `sidecars/context_monitor/public/index.html` & `extras.js :: activateTab` | Keeps `Session` focused; lazy-loads **Cost** & **Accounts** only when active |
| Multi-Account Status Panel + Per-Account Tokens, API Rates & All-Models Breakdown | `src/activity-panel.ts :: buildAccountStatusPanel` | **Ported (Phase 2–3)** | `sidecars/context_monitor/accounts.mjs`, `db.mjs :: listAccountSnapshots`, `backfillLegacyAccountModelsOnce`, `public/accounts.js` | Bordered Token/Cost pills per account, collapsible per-account models, & **All Models & API Rates** card |
| Dedicated Per-Model Quotas (`5h & 7d`) | `src/quota-runway.ts`, `src/quota-extractor.ts` | **Ported (Phase 3)** | `sidecars/context_monitor/accounts.mjs :: extractPerModelQuotas` & `public/accounts.js :: renderPerModelQuotasCard` | Toggleable per-model 5h/7d bars & countdowns inside **Accounts** |
| Usage Breakdown Switcher (`Models` / `Projects` / `Chats`) + Highlighted Token/Cost Pills | *(Fork + DSH Enhanced)* | **Ported (Phase 3)** | `sidecars/context_monitor/db.mjs :: buildProjectAndChatBreakdowns` & `public/extras.js` | Bordered token/USD pills; expandable project tree showing per-chat calls, M tokens & `$` rate |
| Copy `/context` Report & Handoff Prompt | `src/context-breakdown.ts :: formatContextTextReport`, `formatHandoffPrompt` | **Ported (Phase 3)** | `sidecars/context_monitor/public/extras.js :: buildContextReportText`, `buildHandoffText` | Pure string build on click (`~0` overhead) |
| Dual Window Ceiling (`512K` vs `1M`) + Compaction History | `src/webview-overview-tab.ts :: calculateCompressionStats` | **Ported (Phase 3)** | `sidecars/context_monitor/lib.mjs :: parseTranscriptText`, `enrichSummaryWithSpeed` & `extras.js :: renderGaugeExtra` | Computed in single transcript pass |
| Subscription ROI & Local Currency FX + M318/Orchestrator Aliases | `src/cli-usage-scanner.ts :: estimateSubscriptionRoi` | **Ported (Phase 3)** | `db.mjs :: getCostPrefs`, `saveCostPrefs`, `pricing.mjs :: normalizeModelKey` & `public/extras.js` | Zero extra scans; SQLite `kv` prefs |
| Calendar Cost Heatmap, Streaks, Period Charts & App/CLI Filter | `src/webview-calendar-tab.ts` | **Ported (Phase 3)** | `db.mjs :: queryHeatmapSql` & `public/extras.js :: renderHeatmapAnalytics` | `<1 ms` SQLite query vs 14 MB JSON dump |
| Active-Chat Retry/Error Waste, Orchestrator/Executor Role Split, Model DNA & BYOK Isolation | `src/turn-diagnostics.ts`, `src/orchestrator-attribution.ts`, `src/model-dna-store.ts`, `src/quota-runway.ts :: isCustomModel` | **Ported (Phase 4)** | `sidecars/context_monitor/diagnostics.mjs :: analyzeActiveDiagnostics`, `quotas.mjs :: isCustomOrByokModel`, `db.mjs :: recordQuotaSamplesAndComputeRunway`, `public/extras.js :: renderDiagnostics` | Active chat + `config.json` + live `generatorMetadata` only; zero cross-chat step caching; `0` RPCs when hidden in `Sections` |
| CDP Ambient Composer Ring / Top Bar & VS Code Status Bar | `src/app/cdp-injector.ts`, `src/statusbar.ts` | **Skipped (Excluded)** | *Intentionally omitted* | Avoids Chrome remote debugging injection & host DOM polling bloat |
| Future Go HTTP Sidecar Swap | `alpha 2` plan | **Planned (Phase 5+)** | Keep `public/` REST-only (`docs/ARCHITECTURE.md`) | Potential drop from ~85 MB -> ~10–18 MB RAM |

---

### Phased Execution Plan
1. **Phase 1 (Done — `87b25bd`):** Match `Sections` toggle names 1:1 with card headings, fix narrow-pane right-edge clipping, fix `/api/breakdown` zero-token `promptSections` step fallback, and initialize `docs/PORTING_MATRIX.md`.
2. **Phase 2 (Done — `a252322`):** Shipped **4-Tab Layout** (`Session` | `Cost` | `Accounts` | `Heatmap`), top-right compact `Accounts` pill, and SQLite `accounts` + `account_daily` stores tracking active/cached account pools, reset countdowns, AI credits, `Remove` button, and **per-account total token usage** (with zero-double-count one-time legacy seed).
3. **Phase 3 (Done — `09b5979`):** Added bordered `.cm-tok-pill`/`.cm-cost-pill` badges, **Models / Projects / Chats** drilldown inside **Cost**, M318/orchestrator pricing aliases, Currency FX & Subscription ROI, **All Models & API Rates** + **Per-Model Quotas (`5h & 7d`)** inside **Accounts**, **Copy `/context`** & **Copy Handoff**, **Dual Ceiling (`1M` Native) & Compactions** strip, and SQLite **Heatmap Analytics** (`Tokens`/`$ Cost`, `All/App/CLI`, streaks, `7d`/`30d`/`Year`).
4. **Phase 4 (Done — `78e71bd`):** Added `Sections`-toggleable **Orchestrator vs Executor** role/cold-cache reset card (`~/.gemini/config/config.json` + live `generatorMetadata`), **Retries & Errors** wasted token/USD counter, **Model DNA** config card, and **BYOK / Custom-Model Quota Isolation** without cross-chat JSON bloat.
5. **Phase 5 (Done — Verified Parity & Ready to Retire Legacy):** Verified all 32+ doc `::` Code Anchors, 17/17 `Sections` 1:1 parity, `19/19` Node unit tests, `11/11` Electron runtime tests, strict `agy plugin validate`, green GitHub Actions CI, and live telemetry benchmark (**`Context` `88.2 MB` Private RAM / `6.88s` CPU** vs legacy `Antigravity Context Monitor` **`751.2 MB` Private RAM / `1,625.61s` CPU**). Ready to disable/uninstall legacy `antigravity-context-monitor` cleanly whenever you choose.
