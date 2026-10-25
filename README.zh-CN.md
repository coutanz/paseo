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
  跨 Windows / macOS 多主机统一调度 + 全量本地会话无损接管与双向同步 + 原生 Windows Computer Use & Browser Use 增强底座
</p>

---

## 🚀 Omni 增强版核心特性（基于 Paseo `v0.13.0` 深度定制）

本仓库（[`coutanz/paseo`](https://github.com/coutanz/paseo)）在上游 `getpaseo/paseo` (`v0.13.0`) 基础上，针对四大主力桌面 Agent 补齐了**官方索引源无损全量导入**、**桌面端与手机端实时双向同步**以及**跨机 Windows Computer Use** 能力：

1. **官方项目优先映射 + 方式 B 四大客户端自由对话收件箱 (`scripts/omni-session-store.mjs` & `scripts/sync-existing-sessions.mjs`)**：
   - **官方项目自动对齐与 Worktree 归并**：直读 Codex (`~/.codex/.codex-global-state.json` + `state_5.sqlite`) 与 ZCode (`~/.zcode/v2/tasks-index.sqlite`) 的官方 `projects` / `project_roots` 注册表，自动将多子仓库（如 `90CN-Server`、`90CN-ClientPatch`、`90CN-PVF`）与 Git Worktrees（如 `worktrees/*/90CN-Server`、`worktrees/*/arad40`）归并到唯一主项目（`90CN`、`JP40`、`Citris60` 等），并将官方项目显示名称同步写入 `~/.paseo/projects/{projects,workspaces}.json`。
   - **方式 B 自由对话收件箱**：所有未绑定项目的随手新建对话（`new-chat*`、`draft-*`、`default-workspace` 等）按客户端自动归入 4 个专属收件箱项目：**`Codex 自由对话`**、**`Antigravity 自由对话`**、**`ZCode 自由对话`**、**`DSH 自由对话`**，同时保留每条会话的真实物理路径 (`realCwd`) 供续接对话时在原目录执行工具。
   - **严苛子代理与噪音剔除**：
     - **OpenAI Codex**：剔除 `source LIKE '%subagent%'`（含 `thread_spawn` 子代理与 `guardian` 自动代码审查子代理）、`source = 'exec'` 脚本任务以及 `CodexBridgeService` 后台探测任务，自动剥离剪贴板截图临时路径前缀还原真实标题。
     - **Google Antigravity**：直读桌面端 `~/.gemini/antigravity/conversation_summaries.db`（剔除 2 步中断草稿、CLI 测试会话与后台 Subagent）与**未截断的 `transcript_full.jsonl`**，严格保留 `USER_EXPLICIT` 真实输入并将中间推理步骤折叠进思考块。
     - **GLM ZCode**：关联 `~/.zcode/v2/tasks-index.sqlite`（过滤桌面端已删除/已归档/空白草稿任务）与 `~/.zcode/cli/db/db.sqlite`，剔除 `system_reminder` / `todo_reminder` 隐藏注入，按 `finish === "stop"` 提纯每轮最终回复。
     - **DeepSeek Harness (DSH)**：读取 `~/.dsh/storages/workspace.json` + `session_projcache/sessions/*.json`（剔除归档会话、空会话与子代理），从 `session.v4.jsonl.zstd` 严格按 `source.kind === "user"` 提取真实问答。
2. **手机端 ↔ 四大桌面客户端 App 级实时双向同步 (`scripts/omni-acp-bridge.mjs` & `scripts/dsh-paseo-connector.mjs`)**：
   - **Antigravity 桌面版 IDE 实时联动**：自动探测本机运行中的 Antigravity `language_server` ConnectRPC 端口与 CSRF 令牌，通过 `SendUserCascadeMessage` / `StartCascade` / `GetCascadeTrajectorySteps` 实现手机端发消息直接在桌面 IDE 对话框实时滚动执行；桌面端未启动时自动回退至 `agy` CLI (`--conversation` + `--dangerously-skip-permissions`)。
   - **DSH 桌面版 Cordis 进程内直连 (`@paseo-omni/dsh-desktop-connector`)**：自动向 `~/.dsh/profiles/desktop` 注入免配对 Cordis 桥接插件，直接挂载 DSH 桌面端内存中的 `ctx.sessionController` 与 `ctx.workspaceController`，实现手机端与 DSH 桌面窗口实时同步；桌面端未启动时自动回退至 `dsh` CLI。
   - **ZCode 桌面版 Provider 配置注入与任务索引回写**：自动注入 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 与 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`，通过 `zcode.cjs --surface desktop --resume <id>` 原地续接共享 SQLite，并在每轮结束后自动回写 `~/.zcode/v2/tasks-index.sqlite`，使 ZCode 桌面端侧边栏实时刷新置顶。
   - **OpenAI Codex 原生双向同步**：原生复用 `codex app-server` 读写同一 rollout 日志与 `state_5.sqlite`；即使遇到被桌面端锁定的活跃线程，`codex-desktop` 桥接器也会优先尝试原地 `codex exec resume` 并在锁冲突时无缝切换分支。
3. **四大 Agent 共享的 Computer Use & Browser Use 一键注入 (`scripts/sync-computer-use-mcp.mjs`)**：
   - 一条命令自动定位 Windows `codex.exe` 路径，并将 **`windows-desktop` (`uvx windows-mcp`)**、**`computer-use` (`@qwen-code/open-computer-use`)** 以及 **`browser-use` (`@playwright/mcp`)** 同步写入 Codex、Antigravity、ZCode、DSH 与 Paseo Daemon 配置。
4. **Windows Session 1+ 交互式桌面守护与跨机 NetBird 编排 (`scripts/setup-windows-node.ps1` & `scripts/omni-swarm-mcp.mjs`)**：
   - 自动绑定 NetBird 虚拟局域网 IP (`100.x.x.x`)，确保运行在当前登录的 GUI 桌面会话（Session 1+）中，杜绝 `Session 0` 截屏黑屏问题，并支持跨机器 MCP 统一派发任务。

---

### ⚡ 常用命令速查

```powershell
# 1. 同步本机 4 大 Agent 的 Windows Computer Use & Browser Use MCP 配置（含自动绑定 codex.exe 路径）
npm run omni:sync-mcp

# 2. 将本机 Codex / Antigravity / ZCode / DSH 全部活跃历史会话无损导入到 Paseo（支持 -- --limit 50 按需限制）
npm run omni:sync-sessions

# 3. 清理旧导入索引并重新全量清洗同步全部会话
npm run omni:clean-sync-sessions

# 4. 开启后台实时增量监听：桌面端新开的任意会话 30 秒内自动同步到手机端
npm run omni:watch-sessions

# 5. Windows 节点一键绑定 NetBird IP 并注册桌面交互会话自启任务
npm run omni:setup:win
```

---

## License

Apache-2.0
