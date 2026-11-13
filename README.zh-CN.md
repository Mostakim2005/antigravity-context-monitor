# Antigravity Context Monitor

[English](README.md) | 简体中文

一个零外部依赖的 Antigravity 2.0 Sidecar UI 插件（`SIDECAR_UI_ENTRYPOINT_AUX_PANE`），在右侧辅助面板中实时展示当前会话的上下文占用、Prompt Cache 命中率、TTFT / TPS 速度、按 Prompt 轮次的冷/热启动状态，以及近 16 周历史用量热力图。

## 核心功能

- **256K 自动压缩进度条**：基于最近一次模型调用的 `input_tokens + cache_read_tokens`，对齐 Antigravity 2.0 的 `262,144`（256K）自动压缩阈值，直观展示当前占用与剩余空间。
- **Prompt Cache 拆分**：分别展示 Cache 读取（`cache_read_tokens`）、新增未命中输入（`input_tokens`）、输出（`output_tokens`）及命中率。
- **TTFT、输出速度（TPS）与模型 ID**：通过本地 Antigravity `LanguageServerService`（`GetCascadeTrajectoryGeneratorMetadata`）获取真实的 `timeToFirstToken`（首字延迟）、流式解码 TPS、含首字综合 TPS、会话均值以及当前使用的模型 ID；若接口不可用则自动降级。
- **本会话累计统计**：汇总会话总调用次数、累计 Cache 读取、累计新增输入、累计输出与平均 Cache 命中率。
- **Prompt 轮次 · 冷/热启动**：按每次用户输入（`USER_INPUT`）分组，将每轮首步模型调用判定为 **冷启动**、**部分缓存** 或 **热启动**，并展示净增量（`+Δ`）、调用次数、模型 ID、TTFT 与加权 TPS。
- **16 周历史热力图**：提供独立的 **历史热力图** 标签页，聚合统计 Antigravity 2.0 桌面端与 `agy` CLI（`~/.gemini/*/brain`）的全量 Token（`input + cache_read + output`）、活跃天数、会话数与调用次数；点击任意日期格子可查看当日 Token 拆分与模型 ID 明细（`/api/heatmap/day`）。
- **主题同步**：通过 `/preload.js` 读取宿主注入的 CSS 变量，自动适配当前浅色、深色或自定义主题。

## 工作原理

- **只读本地日志**：读取 `<appData>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`，配合 `mtime`/`size` 缓存与 ETag 增量轮询（`/api/context`）。
- **增量热力图扫描**：扫描桌面端与 CLI 的 `brain/` 目录，按文件 `mtime`/`size` 缓存，仅重新解析发生变化的会话日志（`/api/heatmap?weeks=16`）。
- **本地 Language Server RPC**：直接向 `ANTIGRAVITY_LS_ADDRESS` 请求 `timeToFirstToken` 与 `streamingDuration`，不修改任何 Antigravity 客户端文件或 `app.asar`。
- **零外部 npm 依赖**：仅使用 Node.js 内置模块与 Antigravity 自带的 `sidecar_sdk`。

## 安装方式

### 方式一：通过 `agy` 从 GitHub 安装

```bash
agy plugin install jule-x/antigravity-context-monitor
```

### 方式二：本地克隆并软链

```bash
git clone https://github.com/jule-x/antigravity-context-monitor.git
cd antigravity-context-monitor
ln -s "$(pwd)" ~/.gemini/config/plugins/antigravity-context-monitor
```

校验插件格式：

```bash
agy plugin validate ~/.gemini/config/plugins/antigravity-context-monitor --strict
```

## 开发与测试

```bash
cd sidecars/context_monitor
node --test test/*.test.mjs
```

## 开源协议

MIT
