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

1. **四大桌面端官方索引源直读与无损全量导入 (`scripts/omni-session-store.mjs` & `scripts/sync-existing-sessions.mjs`)**：
   - **默认全量无上限同步**：取消条数限制，通过零内存休眠态 (`lastStatus: "closed"`) 原子写入 `~/.paseo/agents`，即使一次性导入 300+ 条历史会话也不拉起任何后台子进程、不抢占任何写锁，并 100% 保留原始 `createdAt` / `updatedAt` 时间戳与纯 UTF-8 中文标题，手机端点击任意会话时按需瞬间唤醒。
   - **OpenAI Codex**：直读 `~/.codex/state_5.sqlite` (`threads` 表) 与 `~/.codex/session_index.jsonl`，排除归档会话与子代理 (`agent_role IS NULL`)，自动剥离剪贴板截图临时路径前缀还原真实标题。
   - **Google Antigravity**：直读 `~/.gemini/antigravity*/conversation_summaries.db`（过滤 `parent_conversation_id = ''` 彻底排除后台 Subagent）与**未截断的 `transcript_full.jsonl`**，严格保留 `USER_EXPLICIT` 真实输入并将中间推理步骤折叠进思考块。
   - **GLM ZCode**：关联 `~/.zcode/v2/tasks-index.sqlite`（过滤桌面端已删除/已归档任务）与 `~/.zcode/cli/db/db.sqlite`，剔除 `system_reminder` / `todo_reminder` 隐藏注入，按 `finish === "stop"` 提纯每轮最终回复并将工具循环中间过程折叠进思考块。
   - **DeepSeek Harness (DSH)**：读取 `~/.dsh/storages/workspace.json` + `session_projcache/sessions/*.json`（剔除归档会话、空会话与子代理），从 `session.v4.jsonl.zstd` 严格按 `source.kind === "user"` 提取真实问答，彻底过滤 `Time sampled` 与后台通知噪声。
2. **手机端 ↔ 四大桌面客户端实时双向同步 (`scripts/omni-acp-bridge.mjs`)**：
   - **Antigravity 桌面版 IDE 实时联动**：自动探测本机运行中的 Antigravity `language_server` ConnectRPC 端口与 CSRF 令牌，通过 `SendUserCascadeMessage` / `StartCascade` / `GetCascadeTrajectorySteps` 实现手机端发消息直接在桌面 IDE 对话框实时滚动执行；桌面端未启动时自动回退至 `agy` CLI (`--conversation` + `--dangerously-skip-permissions`)。
   - **ZCode 桌面版任务索引回写**：通过 `zcode.cjs --surface desktop --resume <id>` 原地续接共享 SQLite，并在每轮结束后自动回写 `~/.zcode/v2/tasks-index.sqlite`，使 ZCode 桌面端侧边栏实时刷新置顶。
   - **OpenAI Codex 原生双向同步**：原生复用 `codex app-server` 读写同一 rollout 日志与 `state_5.sqlite`；即使遇到被桌面端锁定的活跃线程，`codex-desktop` 桥接器也会优先尝试原地 `codex exec resume` 并在锁冲突时无缝切换分支。
   - **DeepSeek DSH 原地续接**：通过 `dsh --profile headless --json --session-id <id>` 原地追加写入同一 `.jsonl.zstd` 会话文件。
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
