# Antigravity Context Monitor

A zero-dependency Antigravity 2.0 Sidecar UI plugin (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`) that displays real-time context window usage, prompt cache efficiency, TTFT / TPS speed, and per-prompt cold/warm start telemetry in the right-side auxiliary pane.

## Features

- **256K Auto-Compaction Gauge**: Tracks `input_tokens + cache_read_tokens` from the latest model call against Antigravity 2.0's `262,144` (256K) auto-compaction threshold, showing remaining room before compaction.
- **Prompt Cache Breakdown**: Visualizes cached reads (`cache_read_tokens`), fresh uncached input (`input_tokens`), output tokens (`output_tokens`), and cache hit rate.
- **TTFT & Output Speed (TPS)**: Queries the local Antigravity `LanguageServerService` (`GetCascadeTrajectoryGeneratorMetadata`) for real `timeToFirstToken` (TTFT), streaming decode TPS, end-to-end TPS, and session averages. Gracefully degrades if unavailable.
- **Session Cumulative Totals**: Tracks total model calls, cumulative cache reads, cumulative fresh input, cumulative output, and average cache hit rate.
- **Prompt Turn Cold / Warm Start**: Groups the conversation by user prompt (`USER_INPUT`) and classifies the first model call after each prompt as **Cold Start**, **Partial Cache**, or **Warm Start**, along with net context growth (`+Δ`), call count, TTFT, and weighted TPS.
- **16-Week Activity Heatmap**: Dedicated **历史热力图** tab aggregating total tokens (`input + cache_read + output`), active days, sessions, and calls across both Antigravity 2.0 desktop and `agy` CLI (`~/.gemini/*/brain`). Click any day cell for a full token breakdown.
- **Theme Sync**: Uses Antigravity's injected CSS variables via `/preload.js` to follow your active light, dark, or custom theme automatically.

## How It Works

- **Read-only local transcript**: Parses `<appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl` with `mtime`/`size` caching and ETag polling (`/api/context`).
- **Incremental heatmap scanner**: Scans all desktop and CLI `brain/` directories with per-file `mtime`/`size` caching (`/api/heatmap?weeks=16`), updating only changed transcripts.
- **Local Language Server RPC**: Fetches `timeToFirstToken` and `streamingDuration` from `ANTIGRAVITY_LS_ADDRESS` without modifying any Antigravity client files or `app.asar`.
- **Zero external npm dependencies**: Uses only Node.js built-in modules and Antigravity's `sidecar_sdk`.

## Installation

### Option 1: Install from GitHub via `agy`

```bash
agy plugin install <your-github-username>/antigravity-context-monitor
```

### Option 2: Local Clone & Symlink

```bash
git clone https://github.com/<your-github-username>/antigravity-context-monitor.git
cd antigravity-context-monitor
ln -s "$(pwd)" ~/.gemini/config/plugins/antigravity-context-monitor
```

Then validate:

```bash
agy plugin validate ~/.gemini/config/plugins/antigravity-context-monitor --strict
```

## Development & Tests

```bash
cd sidecars/context_monitor
node --test test/*.test.mjs
```

## License

MIT
