# Architecture & Roadmap

### [SUBSYSTEM: Lightweight-Sidecar-Core] | Aliases: architecture, data flow, sqlite, go migration
> **1-Line Summary:** Zero-dependency Node.js sidecar serving vanilla JS/CSS views over REST while persisting incremental byte-offset cursors, quota runway samples, custom prices, and frozen monthly archives in SQLite.

* **Backend Modules (`Code Anchors`):**
  * `sidecars/context_monitor/main.mjs :: getConversationsSnapshot` — `GetAllCascadeTrajectories` subagent/main detection and switcher feed.
  * `sidecars/context_monitor/main.mjs :: getBreakdownSnapshot` — `GetCascadeTrajectoryGeneratorMetadata` + `GetCascadeTrajectorySteps` -> `computeContextBreakdown`.
  * `sidecars/context_monitor/main.mjs :: getScopeSnapshot` — Incremental sync + `queryScopeRows` + `calculateScopeCosts`.
  * `sidecars/context_monitor/main.mjs :: getAccountsSnapshot` — Multi-account quota snapshot + cumulative token attribution (`/api/accounts`).
  * `sidecars/context_monitor/main.mjs :: getQuotasSnapshot` — `RetrieveUserQuotaSummary` + `GetUserStatus` + `extractAICredits` + `recordQuotaSamplesAndComputeRunway`.
  * `sidecars/context_monitor/accounts.mjs :: extractActiveAccountSnapshot` — Extracts signed-in account metadata, pool reset timers, and one-time legacy seed.
  * `sidecars/context_monitor/db.mjs :: scanTranscriptIncremental` — Byte-offset `transcript.jsonl` incremental reader with truncation recovery, account token attribution, and frozen-month skip (`archived = 1`).
  * `sidecars/context_monitor/db.mjs :: exportMonthArchive` — Exports portable monthly JSON bundle and freezes historical conversations.
  * `sidecars/context_monitor/pricing.mjs :: calculateScopeCosts` — Published API rate attribution + user custom overrides.
  * `sidecars/context_monitor/breakdown.mjs :: computeContextBreakdown` — 9-category prompt context classification + Top 5 consumer extraction.

```mermaid
flowchart LR
  UI["public/extras.js & quotas.js & app.js"] -->|REST JSON| API["main.mjs (SidecarApp)"]
  API -->|Live RPC| LS["Antigravity LanguageServer"]
  API -->|Byte-Offset Scan| LOG["brain/*/transcript.jsonl"]
  API -->|Read/Write| DB["node:sqlite context_monitor.db"]
  DB -->|Export/Freeze & Import| ARC["Monthly JSON Archive"]

  classDef ui fill:#1e3a8a,color:#ffffff,stroke:#3b82f6
  classDef srv fill:#065f46,color:#ffffff,stroke:#10b981
  classDef store fill:#78350f,color:#ffffff,stroke:#f59e0b
  class UI ui
  class API srv
  class LS,LOG,DB,ARC store

  subgraph Legend
    L1["Vanilla Frontend UI"]:::ui
    L2["JSON API Sidecar"]:::srv
    L3["Local RPC / Logs / SQLite / JSON"]:::store
  end
```

### [DECISION: Node-Sqlite-Now-Go-Backend-Future] | Aliases: go migration, ram optimization, roadmap
> **1-Line Summary:** `[DECIDED BY: HUMAN]` Keep the lightweight zero-dependency Node.js (`node:sqlite`) backend for immediate Antigravity portability (~80–95 MB RSS), with a clean option to swap the HTTP backend to a compiled Go binary (~8–18 MB RSS) in the future without altering `public/`.

* **Rationale:** Every UI module (`public/*.js`, `public/styles.css`, `public/index.html`) interacts exclusively through documented JSON endpoints (`/api/context`, `/api/quotas`, `/api/scope`, `/api/breakdown`, `/api/conversations`, `/api/pricing`, `/api/archive/export`, `/api/archive/import`, `/api/heatmap`). Replacing `main.mjs` + `.mjs` libraries with a single Go executable later requires zero frontend or `app.asar` changes.
* **Links:** `[FEATURE: Parity-Inventory-Ledger]` (`docs/PORTING_MATRIX.md`)
* **Verified By:** `sidecars/context_monitor/test/features.test.mjs :: db incremental scanning, scope queries, monthly freeze/archive import, quota runway, and custom pricing`
