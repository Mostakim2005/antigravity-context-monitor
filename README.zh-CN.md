# Antigravity Context Monitor

[English](README.md) | 简体中文

一个轻量级 Antigravity 2.0 Sidecar UI 插件（`SIDECAR_UI_ENTRYPOINT_AUX_PANE`），零外部 npm 依赖，在右侧辅助面板实时展示上下文占用、9 分类构成与前 5 大占用项、Prompt Cache 命中率、TTFT/TPS 速度、按统计范围（`当前 / 项目 / 7天 / 30天 / 全部`）汇总的 API 费用、5h/7d 额度与消耗速率预测、会话切换（支持锁定主对话），以及近 16 周历史热力图。

## 核心功能

- **EN | 中文 双语切换**：纯前端轻量 i18n 覆盖层（`i18n.js`，默认英文），不修改任何宿主代码。
- **会话切换与锁定主对话（Lock Main）**：支持下拉切换任意历史会话，开启 **锁定主控** 后在子代理突发执行期间保持跟踪主对话上下文。
- **5h / 7d 模型额度与耗尽时间预测 + AI 积分**：展示 Gemini 与 Claude/GPT 额度池及重置倒计时，结合 SQLite 采样计算消耗速率（`%/h`）与预计耗尽时间，并展示 `availableCredits`。
- **DSH 风格范围统计与 API 费用拆解（当前 | 项目 | 7天 | 30天 | 全部）**：
  - 基于 Node 内置 `node:sqlite` 的字节偏移增量扫描，仅解析新增日志，已归档冻结的月份不再重复扫描。
  - 高对比度 Token 与费用边框徽章，支持 **按模型 / 按项目（含子会话）/ 按会话** 拆解、本地汇率与月度订阅 ROI，以及自定义 API 单价（`$/1M`）。
  - **月度归档导出与冻结**：支持将任意月份统计导出为 JSON 并冻结该月已完结会话，也可随时重新导入 JSON 查看历史月度用量。
- **多账号配额与全模型 API 费率（Accounts 标签页）**：记录各账号累计 Token 与等值 API 费用、可展开的账号模型明细、**全模型用量与费率**汇总以及 **单模型 5h / 7d 剩余额度**。
- **上下文窗口进度条与 9 分类明细 + Top 5 占用项**：同时展示 `512K` 压缩阈值与 `1M` 原生上限、上下文压缩节省统计，以及一键 **复制 `/context`** 与 **交接提示词**。
- **按需显示/隐藏任意栏目（Sections）**：隐藏后的栏目不发送后端 RPC 与扫描请求。
- **亮暗主题高对比度与紧凑排版**：自动跟随 Antigravity 浅色/深色主题变量，修正低对比度配色反转。
- **16 周 SQLite 活动与费用热力图**：聚合桌面端与 `agy` CLI（`~/.gemini/*/brain`）每日用量，支持 `Token / $ 费用`、`全部 / App / CLI` 过滤、连续活跃天数及 `7d / 30d / 今年`汇总。

## 架构说明与未来 Go 语言重构规划

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

- **当前方案（`Alpha 2` — 轻量级 Node.js Sidecar）**：仅使用 Node.js 内置模块（含 `node:sqlite`）与 `sidecar_sdk`，运行内存约 `80–95 MB`（相比传统大体积 Webview/扩展多面板方案大幅精简）。
- **未来可选演进方向（Go 语言后端）**：由于 `sidecars/context_monitor/public/` 中的前端界面完全基于原生 HTML/CSS/JS，并与后端通过清晰的 JSON REST 接口通信（`/api/context`、`/api/quotas`、`/api/scope`、`/api/breakdown`、`/api/conversations`、`/api/pricing`、`/api/archive/*`、`/api/heatmap`），未来可随时将后端无缝重写为独立 **Go** 二进制（内存约 `8–18 MB`），前端 UI 无需改动。

## 安装方式

```bash
agy plugin install Mostakim2005/antigravity-context-monitor
agy plugin validate ~/.gemini/config/plugins/antigravity-context-monitor --strict
```

## 开发与测试

```bash
cd sidecars/context_monitor
node --test test/*.test.mjs
```

## 开源协议

MIT
