#!/usr/bin/env node

/**
 * Paseo Omni — 全量真实历史会话无损同步与守护监听工具
 *
 * 核心特性：
 *   1. 默认无条数限制（`--limit all` / `Infinity`），一次性将本机四大桌面 Agent：
 *      - OpenAI Codex (`~/.codex/state_5.sqlite` + `session_index.jsonl`)
 *      - Google Antigravity (`~/.gemini/antigravity/conversation_summaries.db` + `transcript_full.jsonl`)
 *      - GLM ZCode (`~/.zcode/v2/tasks-index.sqlite` + `cli/db/db.sqlite`)
 *      - DeepSeek Harness (`~/.dsh/storages/workspace.json` + `session_projcache`)
 *      中的全部活跃用户会话（剔除子代理、已归档与已删除会话）同步进 Paseo。
 *   2. 采用零内存休眠态 (`lastStatus: "closed"`) 原子写入 `~/.paseo/agents/<project>/<id>.json`：
 *      - 即使导入 300+ 条会话也不会拉起任何后台子进程，0 内存膨胀、0 Codex 线程写锁占用；
 *      - 100% 保留每条历史会话真实的原始 `createdAt`、`updatedAt` 与中文标题（纯 UTF-8 无乱码）；
 *      - 当用户在手机端或桌面端点击任意会话时，由 Paseo 按需懒加载 (`ensureAgentLoaded`) 唤醒并回放完整对话。
 *   3. 自动调用 `paseo workspace create --isolation local` 为所有涉及的项目目录注册原生工作区分组。
 *
 * 用法：
 *   node --no-warnings scripts/sync-existing-sessions.mjs [--clean] [--limit all|N] [--watch] [--interval 30]
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  listAntigravitySessions,
  listCodexSessions,
  listDshSessions,
  listZCodeSessions,
} from "./omni-session-store.mjs";

const execFileAsync = promisify(execFile);
const isWin = process.platform === "win32";
const homeDir = os.homedir();
const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
const paseoHome = process.env.PASEO_HOME || path.join(homeDir, ".paseo");
const agentsBaseDir = path.join(paseoHome, "agents");
const workspacesJsonPath = path.join(paseoHome, "projects", "workspaces.json");
const ledgerPath = path.join(paseoHome, "omni-imported-sessions.json");

const ACP_PROVIDER_DEFAULTS = {
  antigravity: { model: "claude-opus-4-6-thinking", modeId: "yolo" },
  zcode: { model: "glm-5.3", modeId: "yolo" },
  dsh: { model: "DeepSeek-V4.1-Flash", modeId: "headless" },
  "codex-desktop": { model: "gpt-5.4", modeId: "full-access" },
};

function parseArgs(argv) {
  const opts = {
    limitPerProvider: Infinity,
    clean: false,
    includeArchived: false,
    watch: false,
    intervalSec: 30,
    dryRun: false,
    providers: ["codex", "antigravity", "zcode", "dsh"],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--limit" && argv[i + 1]) {
      const val = String(argv[i + 1]).trim().toLowerCase();
      opts.limitPerProvider =
        val === "all" || val === "0" || val === "infinity"
          ? Infinity
          : Math.max(1, Number.parseInt(val, 10) || Infinity);
      i += 1;
    } else if (arg === "--all") {
      opts.limitPerProvider = Infinity;
    } else if (arg === "--clean") {
      opts.clean = true;
    } else if (arg === "--include-archived") {
      opts.includeArchived = true;
    } else if (arg === "--watch") {
      opts.watch = true;
    } else if (arg === "--interval" && argv[i + 1]) {
      opts.intervalSec = Math.max(5, Number.parseInt(argv[i + 1], 10) || 30);
      i += 1;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--providers" && argv[i + 1]) {
      opts.providers = argv[i + 1]
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      i += 1;
    }
  }
  return opts;
}

/**
 * 与 Paseo 服务端 `packages/server/src/server/agent/agent-storage.ts` 中 `projectDirNameFromCwd` 完全一致
 */
export function projectDirNameFromCwd(cwd) {
  const { root } = path.win32.parse(cwd);
  const withoutRoot = cwd.slice(root.length).replace(/[\\/]+$/, "");
  const sanitizedRoot = root.replace(/[:\\/]+/g, "-").replace(/^-+|-+$/g, "");
  const prefix = sanitizedRoot ? `${sanitizedRoot}-` : "";
  if (!withoutRoot) {
    return sanitizedRoot || "root";
  }
  return prefix + withoutRoot.replace(/[\\/]+/g, "-");
}

function writeJsonAtomicSync(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, filePath);
}

function resolvePaseoRunner() {
  if (isWin) {
    const paseoDir = path.join(localAppData, "Programs", "Paseo");
    const appExe = path.join(paseoDir, "Paseo.exe");
    const runnerJs = path.join(
      paseoDir,
      "resources",
      "app.asar.unpacked",
      "dist",
      "daemon",
      "node-entrypoint-runner.js",
    );
    const cliIndexJs = path.join(
      paseoDir,
      "resources",
      "app.asar",
      "node_modules",
      "@getpaseo",
      "cli",
      "dist",
      "index.js",
    );
    const paseoCmd = path.join(paseoDir, "resources", "bin", "paseo.cmd");
    if (fs.existsSync(appExe) && fs.existsSync(runnerJs)) {
      return {
        exe: appExe,
        prefixArgs: ["--disable-warning=DEP0040", runnerJs, "node-script", cliIndexJs],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          PASEO_NODE_ENV: "production",
          PASEO_DESKTOP_MANAGED: "1",
          PASEO_CLI: paseoCmd,
        },
        shell: false,
      };
    }
  }

  return {
    exe: "paseo",
    prefixArgs: [],
    env: { ...process.env },
    shell: isWin,
  };
}

async function runPaseo(runner, args, timeoutMs = 45_000) {
  const { stdout } = await execFileAsync(runner.exe, [...runner.prefixArgs, ...args], {
    windowsHide: true,
    shell: runner.shell,
    timeout: timeoutMs,
    env: runner.env,
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

async function isDaemonRunning(runner) {
  try {
    const out = await runPaseo(runner, ["daemon", "status", "--json"], 10_000);
    const parsed = JSON.parse(out);
    const state = String(
      parsed?.status || parsed?.state || parsed?.localDaemon?.status || parsed?.localDaemon || "",
    ).toLowerCase();
    if (state.includes("running") || parsed?.running === true || parsed?.pid) {
      return true;
    }
  } catch {
    // 尝试用 `ls --json` 二次探测
  }
  try {
    await runPaseo(runner, ["workspace", "ls", "--json"], 8000);
    return true;
  } catch {
    return false;
  }
}

async function ensureDaemonStarted(runner) {
  if (await isDaemonRunning(runner)) return;
  console.log("[daemon] 正在启动本地 Paseo Daemon...");
  await runPaseo(runner, ["daemon", "start"], 30_000);
}

/**
 * 扫描 `~/.paseo/agents` 下所有已持久化的会话记录，建立 `sessionId -> { filePath, record }` 索引
 */
function scanStoredOmniRecords() {
  const bySid = new Map();
  if (!fs.existsSync(agentsBaseDir)) return bySid;

  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          const record = JSON.parse(fs.readFileSync(fullPath, "utf8"));
          const sid =
            record?.labels?.omni_sid ||
            record?.persistence?.sessionId ||
            record?.runtimeInfo?.sessionId ||
            "";
          if (sid) {
            bySid.set(String(sid), { filePath: fullPath, record });
          }
        } catch {
          // 若遇到之前命令行编码截断损坏的旧 JSON 文件，记录为可清理项
          try {
            const raw = fs.readFileSync(fullPath, "utf8");
            if (raw.includes('"omni_sid"')) {
              bySid.set(`__corrupt__:${fullPath}`, { filePath: fullPath, record: { labels: { omni_sid: "corrupt" } } });
            }
          } catch {
            // ignore
          }
        }
      }
    }
  };

  walk(agentsBaseDir);
  return bySid;
}

async function cleanExistingOmniRecords(runner) {
  const running = await isDaemonRunning(runner);
  if (running) {
    console.log("[clean] 暂停 Paseo Daemon 以清理旧会话索引...");
    try {
      await runPaseo(runner, ["daemon", "stop"], 20_000);
    } catch {
      // ignore
    }
  }

  let removedFiles = 0;
  if (fs.existsSync(agentsBaseDir)) {
    const cleanDir = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          cleanDir(fullPath);
          try {
            if (fs.readdirSync(fullPath).length === 0) {
              fs.rmdirSync(fullPath);
            }
          } catch {
            // ignore
          }
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
          try {
            const raw = fs.readFileSync(fullPath, "utf8");
            if (raw.includes('"omni_sid"')) {
              fs.unlinkSync(fullPath);
              removedFiles += 1;
            }
          } catch {
            // ignore
          }
        }
      }
    };
    cleanDir(agentsBaseDir);
  }

  if (fs.existsSync(ledgerPath)) {
    try {
      fs.unlinkSync(ledgerPath);
    } catch {
      // ignore
    }
  }

  console.log(`[clean] 已清理 ${removedFiles} 条旧导入会话记录。`);
}

function readWorkspaceMapFromDisk() {
  const map = new Map();
  if (!fs.existsSync(workspacesJsonPath)) return map;
  try {
    const list = JSON.parse(fs.readFileSync(workspacesJsonPath, "utf8"));
    if (Array.isArray(list)) {
      for (const ws of list) {
        if (ws?.archivedAt) continue;
        const wsId = ws?.workspaceId || ws?.id;
        const cwd = ws?.cwd;
        if (wsId && cwd) {
          map.set(path.resolve(cwd).toLowerCase(), String(wsId));
        }
      }
    }
  } catch {
    // ignore
  }
  return map;
}

async function provisionWorkspacesForCwds(runner, cwds) {
  let wsMap = readWorkspaceMapFromDisk();
  try {
    const out = await runPaseo(runner, ["workspace", "ls", "--json"], 15_000);
    const parsed = JSON.parse(out);
    const items = Array.isArray(parsed) ? parsed : parsed?.workspaces || [];
    for (const ws of items) {
      const wsId = ws?.workspaceId || ws?.id;
      const cwd = ws?.cwd;
      if (wsId && cwd && !ws?.archivedAt) {
        wsMap.set(path.resolve(cwd).toLowerCase(), String(wsId));
      }
    }
  } catch {
    // ignore
  }

  const missingCwds = [];
  for (const cwd of cwds) {
    const norm = path.resolve(cwd).toLowerCase();
    if (!wsMap.has(norm) && fs.existsSync(cwd)) {
      missingCwds.push(path.resolve(cwd));
    }
  }

  if (missingCwds.length === 0) {
    return wsMap;
  }

  console.log(`[workspace] 正在为 ${missingCwds.length} 个项目目录注册 Paseo 本地工作区...`);
  const concurrency = 4;
  let index = 0;

  const worker = async () => {
    while (index < missingCwds.length) {
      const currentIdx = index;
      index += 1;
      const targetCwd = missingCwds[currentIdx];
      const norm = targetCwd.toLowerCase();
      if (wsMap.has(norm)) continue;

      try {
        const out = await runPaseo(
          runner,
          [
            "workspace",
            "create",
            "--isolation",
            "local",
            "--path",
            targetCwd,
            "--no-background",
            "--json",
          ],
          20_000,
        );
        const parsed = JSON.parse(out);
        const wsId =
          parsed?.workspaceId ||
          parsed?.id ||
          parsed?.workspace?.workspaceId ||
          parsed?.workspace?.id ||
          null;
        if (wsId) {
          wsMap.set(norm, String(wsId));
        }
      } catch {
        // 个别目录若属于同一仓库已存在工作区，后续通过读取 workspaces.json 兜底匹配
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, missingCwds.length) }, () => worker()));

  const refreshed = readWorkspaceMapFromDisk();
  for (const [k, v] of refreshed.entries()) {
    wsMap.set(k, v);
  }
  return wsMap;
}

function buildStoredAgentRecord(item, workspaceId, agentId = randomUUID()) {
  const createdAt = item.createdAt || item.updatedAt || new Date().toISOString();
  const updatedAt = item.updatedAt || createdAt;
  const title = item.title || item.sessionId;

  if (item.provider === "codex") {
    const model = item.model || "gpt-5.4";
    return {
      id: agentId,
      provider: "codex",
      cwd: item.cwd,
      ...(workspaceId ? { workspaceId } : {}),
      createdAt,
      updatedAt,
      lastActivityAt: updatedAt,
      lastUserMessageAt: updatedAt,
      title,
      labels: {
        omni_sid: item.sessionId,
      },
      lastStatus: "closed",
      lastModeId: "auto",
      config: {
        model,
      },
      runtimeInfo: {
        provider: "codex",
        sessionId: item.sessionId,
        model,
        thinkingOptionId: null,
        modeId: "auto",
        extra: {
          collaborationMode: "Default",
        },
      },
      features: [
        {
          type: "toggle",
          id: "plan_mode",
          label: "Plan",
          description: "Switch Codex into planning-only collaboration mode",
          tooltip: "Toggle plan mode",
          icon: "list-todo",
          value: false,
        },
      ],
      persistence: {
        provider: "codex",
        sessionId: item.sessionId,
        nativeHandle: item.sessionId,
        metadata: {
          provider: "codex",
          cwd: item.cwd,
          ...(item.model ? { model: item.model } : {}),
        },
      },
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      internal: false,
    };
  }

  const effectiveProvider = item.provider;
  const defaults = ACP_PROVIDER_DEFAULTS[effectiveProvider] || ACP_PROVIDER_DEFAULTS.zcode;

  return {
    id: agentId,
    provider: effectiveProvider,
    cwd: item.cwd,
    ...(workspaceId ? { workspaceId } : {}),
    createdAt,
    updatedAt,
    lastActivityAt: updatedAt,
    lastUserMessageAt: updatedAt,
    title,
    labels: {
      omni_sid: item.sessionId,
    },
    lastStatus: "closed",
    lastModeId: defaults.modeId,
    config: {
      modeId: defaults.modeId,
      model: defaults.model,
    },
    runtimeInfo: {
      provider: effectiveProvider,
      sessionId: item.sessionId,
      model: defaults.model,
      thinkingOptionId: null,
      modeId: defaults.modeId,
      extra: {
        title,
        updatedAt,
      },
    },
    features: [
      {
        type: "toggle",
        id: "auto_accept",
        label: "Auto Accept",
        description: "Automatically approves ACP permission prompts.",
        tooltip: "Auto accept permission prompts",
        icon: "shield-check",
        value: true,
      },
    ],
    persistence: {
      provider: effectiveProvider,
      sessionId: item.sessionId,
      nativeHandle: item.sessionId,
      metadata: {
        provider: "acp",
        cwd: item.cwd,
        model: defaults.model,
        title,
        modeId: defaults.modeId,
      },
    },
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    internal: false,
  };
}

function collectCandidateSessions(opts) {
  const all = [];
  if (opts.providers.includes("codex")) {
    all.push(
      ...listCodexSessions({
        limit: opts.limitPerProvider,
        includeArchived: opts.includeArchived,
      }),
    );
  }
  if (opts.providers.includes("antigravity")) {
    all.push(...listAntigravitySessions({ limit: opts.limitPerProvider }));
  }
  if (opts.providers.includes("zcode")) {
    all.push(
      ...listZCodeSessions({
        limit: opts.limitPerProvider,
        includeArchived: opts.includeArchived,
      }),
    );
  }
  if (opts.providers.includes("dsh")) {
    all.push(
      ...listDshSessions({
        limit: opts.limitPerProvider,
        includeArchived: opts.includeArchived,
      }),
    );
  }
  return all.sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
}

async function hasRunningLiveAgent(runner) {
  try {
    const out = await runPaseo(runner, ["ls", "--json"], 10_000);
    const agents = JSON.parse(out);
    if (Array.isArray(agents)) {
      return agents.some((a) => a?.status === "running" || a?.lastStatus === "running");
    }
  } catch {
    // ignore
  }
  return false;
}

async function syncOnce(opts, runner, { allowClean = false } = {}) {
  if (allowClean && opts.clean && !opts.dryRun) {
    await cleanExistingOmniRecords(runner);
  }

  const candidates = collectCandidateSessions(opts);
  const existingBySid = scanStoredOmniRecords();

  if (opts.dryRun) {
    const byProv = {};
    let pending = 0;
    for (const item of candidates) {
      byProv[item.provider] = (byProv[item.provider] || 0) + 1;
      if (!existingBySid.has(item.sessionId)) pending += 1;
    }
    console.log(`[dry-run] 扫描到活跃会话共 ${candidates.length} 条:`, byProv, `(待新增 ${pending} 条)`);
    return pending;
  }

  await ensureDaemonStarted(runner);

  // 收集本次待导入或待补齐工作区的所有项目目录
  const uniqueCwds = [...new Set(candidates.map((c) => path.resolve(c.cwd)))];
  const wsMap = await provisionWorkspacesForCwds(runner, uniqueCwds);

  let createdCount = 0;
  let updatedCount = 0;
  const ledgerKeys = [];

  for (const item of candidates) {
    const normCwd = path.resolve(item.cwd).toLowerCase();
    const workspaceId = wsMap.get(normCwd);
    const existing = existingBySid.get(item.sessionId);

    ledgerKeys.push(`${item.provider}:${item.sessionId}`);
    ledgerKeys.push(`*:${item.sessionId}`);

    if (!existing) {
      const record = buildStoredAgentRecord(item, workspaceId);
      const targetFile = path.join(
        agentsBaseDir,
        projectDirNameFromCwd(record.cwd),
        `${record.id}.json`,
      );
      writeJsonAtomicSync(targetFile, record);
      createdCount += 1;
    } else if (existing.record?.lastStatus === "closed") {
      // 对休眠态已导入会话同步刷新标题、最新活跃时间与缺失的 workspaceId
      const rec = existing.record;
      const nextUpdated =
        Date.parse(item.updatedAt) > Date.parse(rec.updatedAt || "")
          ? item.updatedAt
          : rec.updatedAt;
      const needTitleFix = item.title && rec.title !== item.title;
      const needWsFix = workspaceId && !rec.workspaceId;
      const needTimeFix = nextUpdated !== rec.updatedAt;

      if (needTitleFix || needWsFix || needTimeFix) {
        const nextRec = {
          ...rec,
          ...(needTitleFix ? { title: item.title } : {}),
          ...(needWsFix ? { workspaceId } : {}),
          ...(needTimeFix ? { updatedAt: nextUpdated, lastActivityAt: nextUpdated } : {}),
        };
        writeJsonAtomicSync(existing.filePath, nextRec);
        updatedCount += 1;
      }
    }
  }

  writeJsonAtomicSync(ledgerPath, Array.from(new Set(ledgerKeys)));

  if (createdCount > 0 || updatedCount > 0 || (allowClean && opts.clean)) {
    const busy = await hasRunningLiveAgent(runner);
    if (!busy) {
      console.log(
        `[reload] 已写入新增 ${createdCount} 条 / 刷新 ${updatedCount} 条会话，正在重启 Daemon Worker 加载索引...`,
      );
      await runPaseo(runner, ["daemon", "restart"], 30_000);
    } else {
      console.log(
        `[reload] 已写入新增 ${createdCount} 条 / 刷新 ${updatedCount} 条会话（当前有运行中任务，跳过热重启以避免中断）。`,
      );
    }
  }

  return createdCount;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runner = resolvePaseoRunner();

  console.log("=== Paseo Omni: 全量本地真实会话清洗与同步 ===");
  const count = await syncOnce(opts, runner, { allowClean: true });
  const totalStored = scanStoredOmniRecords().size;
  console.log(`=== 同步完成（本次新增 ${count} 条，当前 Paseo 共纳管 ${totalStored} 条真实会话） ===`);

  if (opts.watch) {
    console.log(
      `[watch] 正在每 ${opts.intervalSec} 秒持续监听 Codex / Antigravity / ZCode / DSH 新会话...`,
    );
    setInterval(() => {
      syncOnce(opts, runner, { allowClean: false }).catch((err) => {
        console.error("[watch] 增量同步异常:", err);
      });
    }, opts.intervalSec * 1000);
  }
}

main().catch((err) => {
  console.error("会话同步失败:", err);
  process.exit(1);
});
