<p align="center">
  <img src="packages/website/public/logo.svg" width="64" height="64" alt="Paseo logo">
</p>

<h1 align="center">Paseo (Omni Multi-Agent Edition)</h1>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <strong>ZCode (GLM-5.3) · OpenAI Codex · Google Antigravity (<code>agy</code>) · DeepSeek (<code>dsh</code>)</strong><br>
  跨 Windows / macOS 多主机统一调度 + 全量本地会话无缝接管 + 原生 Windows Computer Use & Browser Use 增强底座
</p>

---

## 🚀 Omni 增强版核心特性（针对 NetBird 异地组网与 Windows 桌面控制定制）

本分支（[`coutanz/paseo`](https://github.com/coutanz/paseo)）在上游 `getpaseo/paseo` 基础上，专门补齐了四大主力 Agent 的原生驱动、本地存量会话自动发现/回放以及跨机 Windows Computer Use 能力：

1. **四大主力 Agent 全量内置驱动与通用 ACP 桥接 (`plugins/` & `scripts/omni-acp-bridge.mjs`)**：
   - **GLM ZCode (`plugins/zcode-provider`)**：原生对接 Z.AI 官方 `zcode` CLI（支持 `glm-5.3` / `glm-5.3-flash` / `glm-5.1` / `glm-5-turbo`，内置 `yolo` 无人值守全权限模式、图片附件 `--attach` 与会话恢复 `--resume`）。
   - **DeepSeek Harness (`plugins/dsh-provider`)**：原生对接 `dsh --profile headless --json` 与 ACP 服务模式。
   - **Google Antigravity (`plugins/antigravity-provider`)**：原生对接 `agy` CLI 流式 JSON 协议及桌面端 Brain 对话记录。
   - **OpenAI Codex (`codex` & `codex-desktop`)**：解禁 `CodexProviderOptionsSchema` 严格校验，并针对正被 Codex 桌面端打开锁定的活跃线程提供无锁镜像接管（`codex-desktop`）。
2. **存量本地会话自动发现与完整历史消息回放 (`scripts/omni-session-store.mjs` & `scripts/sync-existing-sessions.mjs`)**：
   - 直读四大客户端本地数据库与日志（Codex `~/.codex/sessions/*.jsonl`、Antigravity `~/.gemini/antigravity*/brain/*/transcript.jsonl`、ZCode `~/.zcode/cli/db/db.sqlite`、DeepSeek DSH `~/.dsh/sessions/*/*/session.v4.jsonl.zstd`）。
   - 支持 ACP 标准 `session/list` 与 `session/load` 历史气泡流式回放，并提供一键批量导入（`npm run omni:sync-sessions`）与后台实时增量监听同步（`npm run omni:watch-sessions`），在桌面端聊了一半的会话打开手机即可直接看到并继续对话。
3. **四大 Agent 共享的 Computer Use & Browser Use 一键注入 (`scripts/sync-computer-use-mcp.mjs`)**：
   - 一条命令自动将 **`windows-desktop` (`uvx windows-mcp`)**、**`computer-use` (`@qwen-code/open-computer-use`)** 以及 **`browser-use` (`@playwright/mcp`)** 同时同步写入：
     - Codex (`~/.codex/config.toml`)
     - Antigravity (`~/.gemini/antigravity-cli/settings.json`)
     - ZCode (`~/.zcode/cli/config.json` & `setting.json`)
     - DeepSeek DSH (`~/.dsh/config.json`)
     - Paseo Daemon (`~/.paseo/config.json`)
4. **Windows Session 1+ 交互式桌面守护与 NetBird 自动绑定 (`scripts/setup-windows-node.ps1`)**：
   - 自动识别本机 **NetBird 虚拟局域网 IP (`100.x.x.x`)**。
   - 自动注册 Windows 计划任务 `PaseoOmniDaemon`（强制 `LogonType = Interactive` 运行在当前登录的 GUI 桌面会话 Session 1+ 中，彻底解决传统 SSH / Windows 服务落在 `Session 0` 导致截屏黑屏、无法点击窗口的痛点）。
5. **跨机器主从编排器 MCP (`scripts/omni-swarm-mcp.mjs`)**：
   - 可挂载到主力机的 Antigravity / Codex / ZCode 中，提供 `paseo_swarm_list_nodes`、`paseo_swarm_register_node`、`paseo_swarm_dispatch_agent` 等工具，让你在主力机通过一句话跨 NetBird 指挥任意 Windows/Mac 节点上的指定 Agent 干活。

---

### ⚡ 常用命令速查

```powershell
# 1. 同步本机 4 大 Agent 的 Windows Computer Use & Browser Use MCP 配置
npm run omni:sync-mcp

# 2. 将电脑上现有的 Codex / Antigravity / ZCode / DSH 历史会话一键导入到手机端列表（默认每个 Agent 导入最近 4 条，可传 -- --limit 15）
npm run omni:sync-sessions

# 3. 开启后台实时监听：电脑桌面新开的任意会话 30 秒内自动同步到手机端
npm run omni:watch-sessions

# 4. Windows 节点一键绑定 NetBird IP 并注册桌面交互会话自启任务
npm run omni:setup:win
```

---

## License

Apache-2.0
