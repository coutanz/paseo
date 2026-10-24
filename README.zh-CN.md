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
  跨 Windows / macOS 多主机统一调度 + 原生 Windows Computer Use & Browser Use 增强底座
</p>

---

## 🚀 Omni 增强版核心特性（针对 NetBird 异地组网与 Windows 桌面控制定制）

本分支（[`coutanz/paseo`](https://github.com/coutanz/paseo)）在上游 `getpaseo/paseo` 基础上，专门补齐了四大主力 Agent 的原生驱动与跨机 Windows Computer Use 能力：

1. **四大主力 Agent 全量内置驱动 (`plugins/`)**：
   - **GLM ZCode (`plugins/zcode-provider`)**：原生对接 Z.AI 官方 `zcode` CLI（支持 `glm-5.3` / `glm-5.3-flash` / `glm-5.1` / `glm-5-turbo`，内置 `yolo` 无人值守全权限模式、图片附件 `--attach` 与会话恢复 `--resume`）。
   - **DeepSeek Harness (`plugins/dsh-provider`)**：原生对接 `dsh acp` (Agent Client Protocol) 服务模式。
   - **Google Antigravity (`plugins/antigravity-provider`)**：原生对接 `agy` CLI 流式 JSON 协议。
   - **OpenAI Codex (`codex`)**：解禁 `CodexProviderOptionsSchema` 严格校验，原生支持在 Paseo 中透传 `features: { computer_use: true, browser_use: true, plugins: true, apps: true }`。
2. **四大 Agent 共享的 Computer Use & Browser Use 一键注入 (`scripts/sync-computer-use-mcp.mjs`)**：
   - 一条命令自动将 **`windows-desktop` (`uvx windows-mcp`)**、**`computer-use` (`@qwen-code/open-computer-use`)** 以及 **`browser-use` (`@playwright/mcp`)** 同时同步写入：
     - Codex (`~/.codex/config.toml`)
     - Antigravity (`~/.gemini/antigravity-cli/settings.json`)
     - ZCode (`~/.zcode/cli/setting.json`)
     - DeepSeek DSH (`~/.dsh/config.json`)
     - Paseo Daemon (`~/.paseo/config.json`)
3. **Windows Session 1+ 交互式桌面守护与 NetBird 自动绑定 (`scripts/setup-windows-node.ps1`)**：
   - 自动识别本机 **NetBird 虚拟局域网 IP (`100.x.x.x`)**。
   - 自动注册 Windows 计划任务 `PaseoOmniDaemon`（强制 `LogonType = Interactive` 运行在当前登录的 GUI 桌面会话 Session 1+ 中，彻底解决传统 SSH / Windows 服务落在 `Session 0` 导致截屏黑屏、无法点击窗口的痛点）。
4. **跨机器主从编排器 MCP (`scripts/omni-swarm-mcp.mjs`)**：
   - 可挂载到主力机的 Antigravity / Codex / ZCode 中，提供 `paseo_swarm_list_nodes`、`paseo_swarm_register_node`、`paseo_swarm_dispatch_agent` 等工具，让你在主力机通过一句话跨 NetBird 指挥任意 Windows/Mac 节点上的指定 Agent 干活。

---

### ⚡ 三步部署你的多机 Agent 集群

#### 第一步：在每台 Windows 节点上执行一键初始化
以管理员或当前桌面用户打开 PowerShell：
```powershell
# 自动探测 NetBird IP、为 4 大 CLI 注入 Windows Computer Use & Browser Use MCP，并注册桌面会话自启守护任务
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-node.ps1

# 如果要同时绑定本地已打开远程调试端口的 Chrome 浏览器（复用登录态 Cookie）：
powershell -ExecutionPolicy Bypass -File .\scripts\setup-windows-node.ps1 -CdpEndpoint "http://127.0.0.1:9222"
```

#### 第二步：在每台 macOS 节点上执行初始化
```bash
chmod +x ./scripts/setup-mac-node.sh
./scripts/setup-mac-node.sh
```

#### 第三步：单独同步本机四大 Agent 的 Computer Use MCP 配置
如果你只想更新本机的 Codex / Antigravity / ZCode / DSH 配置文件：
```bash
node ./scripts/sync-computer-use-mcp.mjs
```

#### 第四步：在主力机挂载跨节点 Swarm 编排器（可选）
在主力机执行以下命令，即可让你的 Antigravity (`agy`) 或 Codex 直接具备跨机器派活能力：
```bash
agy mcp add paseo-swarm node C:/path/to/paseo/scripts/omni-swarm-mcp.mjs
```

---

## 上游 Paseo 基础介绍

在你自己的机器上并行运行 agents。无论在手机上还是桌前，都能推进交付。

- **自托管：** Agents 在你的机器上运行，使用完整的本地开发环境、工具、配置和技能。
- **多提供商：** 通过同一个界面使用 Claude Code、Codex、Copilot、OpenCode、Pi、Antigravity、ZCode 和 DeepSeek DSH。为每个任务选择合适的模型。
- **语音控制：** 在语音模式下口述任务或讨论问题。需要免手操作时很方便。
- **跨设备：** 支持 iOS、Android、桌面端、Web 和 CLI。在桌前开始工作，用手机查看进度，也可以从终端脚本化操作。
- **隐私优先：** Paseo 没有遥测、追踪，也不会强制登录。

## 快速开始

Paseo 会运行一个名为 daemon 的本地服务，用来管理你的 coding agents。桌面 app、移动 app、Web app 和 CLI 等客户端都会连接到它。

### CLI / 无头模式

安装 CLI 并启动 Paseo：

```bash
npm install -g @getpaseo/cli
paseo
```

终端中会显示一个二维码。你可以从任意客户端连接。这个方式适合服务器和远程机器。

完整安装和配置见：

- [文档](https://paseo.sh/zh-CN/docs)
- [配置参考](https://paseo.sh/zh-CN/docs/configuration)

## CLI

你能在 app 中完成的事情，也都可以在终端中完成。

```bash
paseo run --provider zcode/glm-5.3 "在 Windows 桌面上打开浏览器并检查本地服务状态"
paseo run --provider codex/gpt-5.4 --worktree feature-x "implement feature X"
paseo run --provider antigravity "audit the codebase"
paseo run --provider dsh "optimize algorithm performance"

paseo ls                           # 列出正在运行的 agents
paseo attach abc123                # 实时流式查看输出
paseo send abc123 "also add tests" # 发送后续任务

# 在远程 NetBird 节点 daemon 上运行
paseo --host 100.119.1.10:6767 run --provider zcode/glm-5.3 "run Windows GUI regression suite"
```

## License

Apache-2.0
