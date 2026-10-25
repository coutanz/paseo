#!/usr/bin/env node

/**
 * Paseo Omni — 全量真实历史会话无损同步、官方项目对齐与守护监听工具 (Phase 6)
 *
 * 核心特性：
 *   1. 官方项目优先映射 + 方式 B 四大客户端自由对话收件箱：
 *      - 自动读取 Codex 与 ZCode 官方 `projects` / `project_roots` 表，将多子仓库与 Git Worktrees
 *        （如 `90CN-Server` 各分支工作树、`arad40` 工作树）归并到唯一官方项目（`90CN`、`JP40`、`Citris60` 等）；
 *      - 将未绑定项目的随手新建会话按客户端归入 4 个专属收件箱项目：
 *        `Codex 自由对话`、`Antigravity 自由对话`、`ZCode 自由对话`、`DSH 自由对话`；
 *      - 自动将官方项目名称（`customName` / `displayName`）写入 `~/.paseo/projects/projects.json` 与 `workspaces.json`，
 *        让 Paseo 左侧栏展示与各客户端 100% 一致的项目名称。
 *   2. 严苛噪音剔除：
 *      - 剔除 Codex `source LIKE '%subagent%'`（106 个 `thread_spawn` 子代理 + 18 个 `guardian` 自动审查代理）及 `exec` 任务；
 *      - 剔除 Antigravity 2 步中断草稿、CLI 测试会话及 `CodexBridgeService` 后台探测任务。
 *   3. 零内存休眠态 (`lastStatus: "closed"`) 原子落盘 + Windows WMI 独立守护进程拉起。
 *
 * 用法：
 *   node --no-warnings scripts/sync-existing-sessions.mjs [--clean] [--limit all|N] [--watch] [--interval 30]
 */

import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  listAntigravitySessions,
  listCodexSessions,
  listDshSessions,
  listZCodeSessions,
  loadCanonicalProjectCatalog,
} from "./omni-session-store.mjs";

const execFileAsync = promisify(execFile);
const isWin = process.platform === "win32";
const homeDir = os.homedir();
const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
const paseoHome = process.env.PASEO_HOME || path.join(homeDir, ".paseo");
const agentsBaseDir = path.join(paseoHome, "agents");
const projectsJsonPath = path.join(paseoHome, "projects", "projects.json");
const workspacesJsonPath = path.join(paseoHome, "projects", "workspaces.json");
const ledgerPath = path.join(paseoHome, "omni-imported-sessions.json");
const presyncStatePath = path.join(paseoHome, "omni-presync-state.json");

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
    bootPresync: false,
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
    } else if (arg === "--boot-presync") {
      opts.bootPresync = true;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
        paseoCmd,
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
    paseoCmd: "paseo",
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
    // fallback
  }
  try {
    await runPaseo(runner, ["workspace", "ls", "--json"], 8000);
    return true;
  } catch {
    return false;
  }
}

async function startDaemonDetached(runner) {
  if (isWin && runner.paseoCmd && fs.existsSync(runner.paseoCmd)) {
    const paseoDir = path.join(localAppData, "Programs", "Paseo");
    const runnerJs = path.join(
      paseoDir,
      "resources",
      "app.asar.unpacked",
      "dist",
      "daemon",
      "node-entrypoint-runner.js",
    );
    const supervisorJs = path.join(
      paseoDir,
      "resources",
      "app.asar",
      "node_modules",
      "@getpaseo",
      "server",
      "dist",
      "scripts",
      "supervisor-entrypoint.js",
    );
    const cmdLine =
      fs.existsSync(runnerJs) && fs.existsSync(supervisorJs)
        ? `cmd.exe /c "set ELECTRON_RUN_AS_NODE=1&& set PASEO_DESKTOP_MANAGED=1&& "${runner.exe}" --disable-warning=DEP0040 "${runnerJs}" node-script "${supervisorJs}""`
        : `cmd.exe /c ""${runner.paseoCmd}" daemon start"`;
    const psScript = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdLine.replace(/'/g, "''")}'; CurrentDirectory = '${homeDir.replace(/'/g, "''")}' } | Out-Null`;
    await execFileAsync("powershell", ["-NoProfile", "-Command", psScript], {
      windowsHide: true,
      timeout: 15_000,
    });
    for (let i = 0; i < 20; i += 1) {
      await sleep(800);
      if (await isDaemonRunning(runner)) return;
    }
  }
  await runPaseo(runner, ["daemon", "start"], 30_000);
}

async function ensureDaemonStarted(runner) {
  if (await isDaemonRunning(runner)) return;
  console.log("[daemon] 正在启动本地 Paseo Daemon...");
  await startDaemonDetached(runner);
}

async function stopDaemonSafe(runner) {
  if (!(await isDaemonRunning(runner))) return;
  try {
    await runPaseo(runner, ["daemon", "stop"], 20_000);
  } catch {
    // ignore
  }
  await sleep(800);
}

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
          try {
            const raw = fs.readFileSync(fullPath, "utf8");
            if (raw.includes('"omni_sid"')) {
              bySid.set(`__corrupt__:${fullPath}`, {
                filePath: fullPath,
                record: { labels: { omni_sid: "corrupt" } },
              });
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
  console.log("[clean] 暂停 Paseo Daemon 以彻底清理旧工作区与会话索引...");
  await stopDaemonSafe(runner);

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
            fs.unlinkSync(fullPath);
            removedFiles += 1;
          } catch {
            // ignore
          }
        }
      }
    };
    cleanDir(agentsBaseDir);
  }

  // 重置 projects.json 与 workspaces.json，彻底清除此前散落创建的 40 个临时目录项目
  writeJsonAtomicSync(projectsJsonPath, []);
  writeJsonAtomicSync(workspacesJsonPath, []);

  if (fs.existsSync(ledgerPath)) {
    try {
      fs.unlinkSync(ledgerPath);
    } catch {
      // ignore
    }
  }

  console.log(`[clean] 已清理 ${removedFiles} 条旧会话记录及全部散乱项目缓存。`);
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

  console.log(`[workspace] 正在为 ${missingCwds.length} 个官方项目与自由对话收件箱注册 Paseo 工作区...`);
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
        // ignore
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

/**
 * 将官方项目名称（如 `90CN`、`JP40`、`Citris60`、`Codex 自由对话`）同步写入 Paseo 的
 * `projects.json` (`customName` + `displayName`) 与 `workspaces.json` (`title` + `displayName`)
 */
function applyCanonicalProjectDisplayNames(cwdToProjectNameMap) {
  if (!fs.existsSync(workspacesJsonPath) || !fs.existsSync(projectsJsonPath)) {
    return false;
  }

  let modified = false;
  try {
    const workspaces = JSON.parse(fs.readFileSync(workspacesJsonPath, "utf8"));
    const projects = JSON.parse(fs.readFileSync(projectsJsonPath, "utf8"));
    if (!Array.isArray(workspaces) || !Array.isArray(projects)) return false;

    const projectIdToDesiredName = new Map();

    for (const ws of workspaces) {
      if (!ws?.cwd) continue;
      const normCwd = path.resolve(ws.cwd).toLowerCase();
      const desiredName = cwdToProjectNameMap.get(normCwd);
      if (!desiredName) continue;

      projectIdToDesiredName.set(ws.projectId, desiredName);
      if (ws.displayName !== desiredName || ws.title !== desiredName) {
        ws.displayName = desiredName;
        ws.title = desiredName;
        modified = true;
      }
    }

    for (const proj of projects) {
      const normRoot = proj?.rootPath ? path.resolve(proj.rootPath).toLowerCase() : "";
      const desiredName =
        projectIdToDesiredName.get(proj.projectId) || cwdToProjectNameMap.get(normRoot);
      if (!desiredName) continue;

      if (proj.displayName !== desiredName || proj.customName !== desiredName) {
        proj.displayName = desiredName;
        proj.customName = desiredName;
        modified = true;
      }
    }

    if (modified) {
      writeJsonAtomicSync(workspacesJsonPath, workspaces);
      writeJsonAtomicSync(projectsJsonPath, projects);
    }
  } catch {
    // ignore
  }
  return modified;
}

/**
 * 纯磁盘级无进程工作区与项目同步：
 * 在 Paseo Daemon 启动前（`runBootPresync`）直接维护 `projects.json` 与 `workspaces.json`，
 * 耗时 <5ms，无需等待或拉起任何 `paseo` CLI 子进程。
 */
function provisionWorkspacesOnDiskSync(cwds, cwdToProjectNameMap) {
  let workspaces = [];
  let projects = [];
  try {
    if (fs.existsSync(workspacesJsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(workspacesJsonPath, "utf8"));
      if (Array.isArray(parsed)) workspaces = parsed;
    }
  } catch {
    workspaces = [];
  }
  try {
    if (fs.existsSync(projectsJsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(projectsJsonPath, "utf8"));
      if (Array.isArray(parsed)) projects = parsed;
    }
  } catch {
    projects = [];
  }

  let serverId = "srv_local";
  try {
    const serverIdFile = path.join(paseoHome, "server-id");
    if (fs.existsSync(serverIdFile)) {
      const raw = fs.readFileSync(serverIdFile, "utf8").trim();
      if (raw) serverId = raw;
    }
  } catch {
    // ignore
  }

  let modified = false;
  const wsByNormCwd = new Map();
  for (const ws of workspaces) {
    if (ws?.cwd && !ws?.archivedAt) {
      wsByNormCwd.set(path.resolve(ws.cwd).toLowerCase(), ws);
    }
  }
  const projByNormRoot = new Map();
  const projById = new Map();
  for (const proj of projects) {
    if (proj?.projectId) projById.set(proj.projectId, proj);
    if (proj?.rootPath && !proj?.archivedAt) {
      projByNormRoot.set(path.resolve(proj.rootPath).toLowerCase(), proj);
    }
  }

  const wsMap = new Map();
  const nowIso = new Date().toISOString();

  for (const rawCwd of cwds) {
    if (!rawCwd || !fs.existsSync(rawCwd)) continue;
    const resolvedCwd = path.resolve(rawCwd);
    const normCwd = resolvedCwd.toLowerCase();
    const desiredName =
      cwdToProjectNameMap.get(normCwd) || path.basename(resolvedCwd) || resolvedCwd;
    const isGit = fs.existsSync(path.join(resolvedCwd, ".git"));

    let proj = projByNormRoot.get(normCwd);
    let ws = wsByNormCwd.get(normCwd);

    if (ws && !proj && ws.projectId) {
      proj = projById.get(ws.projectId);
    }

    if (!proj) {
      const projectId = ws?.projectId || `prj_${randomBytes(8).toString("hex")}`;
      proj = {
        projectId,
        rootPath: resolvedCwd,
        kind: isGit ? "git" : "non_git",
        displayName: desiredName,
        projectKey: `host:${serverId}:${normCwd}`,
        customName: desiredName,
        customIconRevision: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        archivedAt: null,
      };
      projects.push(proj);
      projByNormRoot.set(normCwd, proj);
      projById.set(projectId, proj);
      modified = true;
    } else if (proj.displayName !== desiredName || proj.customName !== desiredName) {
      proj.displayName = desiredName;
      proj.customName = desiredName;
      modified = true;
    }

    if (!ws) {
      const workspaceId = `wks_${randomBytes(8).toString("hex")}`;
      ws = {
        workspaceId,
        projectId: proj.projectId,
        cwd: resolvedCwd,
        kind: isGit ? "local_checkout" : "directory",
        displayName: desiredName,
        title: desiredName,
        branch: null,
        worktreeRoot: isGit ? resolvedCwd.replace(/\\/g, "/") : null,
        baseBranch: null,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        archivedAt: null,
        autoArchivedChangeRequestUrl: null,
        pinnedAt: null,
        background: false,
      };
      workspaces.push(ws);
      wsByNormCwd.set(normCwd, ws);
      modified = true;
    } else if (ws.displayName !== desiredName || ws.title !== desiredName) {
      ws.displayName = desiredName;
      ws.title = desiredName;
      modified = true;
    }

    wsMap.set(normCwd, String(ws.workspaceId));
  }

  if (modified) {
    writeJsonAtomicSync(projectsJsonPath, projects);
    writeJsonAtomicSync(workspacesJsonPath, workspaces);
  }

  return { wsMap, modified };
}

function buildStoredAgentRecord(item, workspaceId, agentId = randomUUID()) {
  const createdAt = item.createdAt || item.updatedAt || new Date().toISOString();
  const updatedAt = item.updatedAt || createdAt;
  const title = item.title || item.sessionId;
  const labels = {
    omni_sid: item.sessionId,
    ...(item.projectName ? { omni_project: item.projectName } : {}),
    ...(item.realCwd ? { omni_real_cwd: item.realCwd } : {}),
  };

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
      labels,
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
    labels,
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
    const byProj = {};
    let pending = 0;
    for (const item of candidates) {
      byProv[item.provider] = (byProv[item.provider] || 0) + 1;
      byProj[item.projectName] = (byProj[item.projectName] || 0) + 1;
      if (!existingBySid.has(item.sessionId)) pending += 1;
    }
    console.log(`[dry-run] 扫描到活跃会话共 ${candidates.length} 条:`, byProv, `(待新增 ${pending} 条)`);
    console.log(`[dry-run] 归属项目分布 (${Object.keys(byProj).length} 个项目):`, byProj);
    return pending;
  }

  await ensureDaemonStarted(runner);

  // 收集本次涉及的官方项目目录（含尚无会话但已在客户端注册的官方空项目）与方式 B 自由对话收件箱目录
  const cwdToProjectNameMap = new Map();
  const catalog = loadCanonicalProjectCatalog();
  for (const proj of catalog.projectsByNameLower.values()) {
    if (proj.primaryCwd && fs.existsSync(proj.primaryCwd)) {
      cwdToProjectNameMap.set(path.resolve(proj.primaryCwd).toLowerCase(), proj.name);
    }
  }
  for (const c of candidates) {
    const norm = path.resolve(c.cwd).toLowerCase();
    if (c.projectName) {
      cwdToProjectNameMap.set(norm, c.projectName);
    }
  }
  const uniqueCwds = [
    ...new Set([
      ...[...catalog.projectsByNameLower.values()]
        .map((p) => p.primaryCwd)
        .filter((p) => p && fs.existsSync(p))
        .map((p) => path.resolve(p)),
      ...candidates.map((c) => path.resolve(c.cwd)),
    ]),
  ];
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
    } else if (existing.record?.lastStatus !== "running") {
      const rec = existing.record;
      const itemMs = Date.parse(item.updatedAt);
      const recMs = Date.parse(rec.updatedAt || "");
      const hasExternalDesktopUpdate =
        Number.isFinite(itemMs) && (!Number.isFinite(recMs) || itemMs - recMs > 1500);
      const nextUpdated = hasExternalDesktopUpdate ? item.updatedAt : rec.updatedAt;
      const needTitleFix = item.title && rec.title !== item.title;
      const needWsFix = workspaceId && rec.workspaceId !== workspaceId;
      const needCwdFix = path.resolve(rec.cwd || "") !== path.resolve(item.cwd);
      const needTimeFix = hasExternalDesktopUpdate;

      if (needTitleFix || needWsFix || needCwdFix || needTimeFix) {
        const nextRec = {
          ...rec,
          cwd: item.cwd,
          // 当用户在原桌面客户端继续对话产生新消息时，重置为 closed 休眠态，
          // 确保下次在 Paseo 点击该会话时重新从桌面端数据库/日志无损拉取最新对话历史
          lastStatus: "closed",
          ...(workspaceId ? { workspaceId } : {}),
          ...(needTitleFix ? { title: item.title } : {}),
          ...(needTimeFix
            ? {
                updatedAt: nextUpdated,
                lastActivityAt: nextUpdated,
                lastUserMessageAt: nextUpdated,
              }
            : {}),
          labels: {
            ...(rec.labels || {}),
            omni_sid: item.sessionId,
            ...(item.projectName ? { omni_project: item.projectName } : {}),
            ...(item.realCwd ? { omni_real_cwd: item.realCwd } : {}),
          },
        };
        const targetFile = path.join(
          agentsBaseDir,
          projectDirNameFromCwd(nextRec.cwd),
          `${nextRec.id}.json`,
        );
        if (existing.filePath !== targetFile && fs.existsSync(existing.filePath)) {
          try {
            fs.unlinkSync(existing.filePath);
          } catch {
            // ignore
          }
        }
        writeJsonAtomicSync(targetFile, nextRec);
        updatedCount += 1;
      }
    }
  }

  writeJsonAtomicSync(ledgerPath, Array.from(new Set(ledgerKeys)));

  if (createdCount > 0 || updatedCount > 0 || (allowClean && opts.clean)) {
    const busy = await hasRunningLiveAgent(runner);
    if (!busy) {
      console.log(
        `[reload] 已写入新增 ${createdCount} 条 / 刷新 ${updatedCount} 条会话，正在同步项目自定义名称并重启 Daemon...`,
      );
      await stopDaemonSafe(runner);
      applyCanonicalProjectDisplayNames(cwdToProjectNameMap);
      await startDaemonDetached(runner);
    } else {
      applyCanonicalProjectDisplayNames(cwdToProjectNameMap);
      console.log(
        `[reload] 已写入新增 ${createdCount} 条 / 刷新 ${updatedCount} 条会话（当前有运行中任务，跳过重启以避免中断）。`,
      );
    }
  } else {
    const nameChanged = applyCanonicalProjectDisplayNames(cwdToProjectNameMap);
    if (nameChanged && !(await hasRunningLiveAgent(runner))) {
      await stopDaemonSafe(runner);
      await startDaemonDetached(runner);
    }
  }

  return createdCount;
}

/**
 * Paseo Desktop / Daemon 启动前极速预同步钩子 (`runBootPresync`)：
 * 在 `daemon-worker.js`（或 `supervisor-entrypoint.js`）加载磁盘索引前直接同步
 * Codex / Antigravity / ZCode / DSH 的新增会话与外部更新，纯内存+文件原子写入（~120ms），
 * 零子进程开销，绝不阻塞 Daemon 启动。
 */
export async function runBootPresync(options = {}) {
  const quiet = options.quiet !== false;
  const throttleMs = Number.isFinite(options.throttleMs) ? options.throttleMs : 0;

  if (throttleMs > 0 && fs.existsSync(presyncStatePath)) {
    try {
      const state = JSON.parse(fs.readFileSync(presyncStatePath, "utf8"));
      if (state?.lastRunAt && Date.now() - Number(state.lastRunAt) < throttleMs) {
        return { skipped: true, createdCount: 0, updatedCount: 0, wsModified: false };
      }
    } catch {
      // ignore
    }
  }

  const opts = {
    limitPerProvider: Infinity,
    includeArchived: false,
    providers: ["codex", "antigravity", "zcode", "dsh"],
  };

  const candidates = collectCandidateSessions(opts);
  const existingBySid = scanStoredOmniRecords();

  const cwdToProjectNameMap = new Map();
  const catalog = loadCanonicalProjectCatalog();
  for (const proj of catalog.projectsByNameLower.values()) {
    if (proj.primaryCwd && fs.existsSync(proj.primaryCwd)) {
      cwdToProjectNameMap.set(path.resolve(proj.primaryCwd).toLowerCase(), proj.name);
    }
  }
  for (const c of candidates) {
    const norm = path.resolve(c.cwd).toLowerCase();
    if (c.projectName) {
      cwdToProjectNameMap.set(norm, c.projectName);
    }
  }

  const uniqueCwds = [
    ...new Set([
      ...[...catalog.projectsByNameLower.values()]
        .map((p) => p.primaryCwd)
        .filter((p) => p && fs.existsSync(p))
        .map((p) => path.resolve(p)),
      ...candidates.map((c) => path.resolve(c.cwd)),
    ]),
  ];

  const { wsMap, modified: wsModified } = provisionWorkspacesOnDiskSync(
    uniqueCwds,
    cwdToProjectNameMap,
  );

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
    } else if (existing.record?.lastStatus !== "running") {
      const rec = existing.record;
      const itemMs = Date.parse(item.updatedAt);
      const recMs = Date.parse(rec.updatedAt || "");
      const hasExternalDesktopUpdate =
        Number.isFinite(itemMs) && (!Number.isFinite(recMs) || itemMs - recMs > 1500);
      const nextUpdated = hasExternalDesktopUpdate ? item.updatedAt : rec.updatedAt;
      const needTitleFix = item.title && rec.title !== item.title;
      const needWsFix = workspaceId && rec.workspaceId !== workspaceId;
      const needCwdFix = path.resolve(rec.cwd || "") !== path.resolve(item.cwd);
      const needTimeFix = hasExternalDesktopUpdate;

      if (needTitleFix || needWsFix || needCwdFix || needTimeFix) {
        const nextRec = {
          ...rec,
          cwd: item.cwd,
          lastStatus: "closed",
          ...(workspaceId ? { workspaceId } : {}),
          ...(needTitleFix ? { title: item.title } : {}),
          ...(needTimeFix
            ? {
                updatedAt: nextUpdated,
                lastActivityAt: nextUpdated,
                lastUserMessageAt: nextUpdated,
              }
            : {}),
          labels: {
            ...(rec.labels || {}),
            omni_sid: item.sessionId,
            ...(item.projectName ? { omni_project: item.projectName } : {}),
            ...(item.realCwd ? { omni_real_cwd: item.realCwd } : {}),
          },
        };
        const targetFile = path.join(
          agentsBaseDir,
          projectDirNameFromCwd(nextRec.cwd),
          `${nextRec.id}.json`,
        );
        if (existing.filePath !== targetFile && fs.existsSync(existing.filePath)) {
          try {
            fs.unlinkSync(existing.filePath);
          } catch {
            // ignore
          }
        }
        writeJsonAtomicSync(targetFile, nextRec);
        updatedCount += 1;
      }
    }
  }

  writeJsonAtomicSync(ledgerPath, Array.from(new Set(ledgerKeys)));
  writeJsonAtomicSync(presyncStatePath, {
    lastRunAt: Date.now(),
    lastRunIso: new Date().toISOString(),
    createdCount,
    updatedCount,
    wsModified,
    totalCandidates: candidates.length,
  });

  if (
    options.reloadRunningDaemonIfChanged &&
    (createdCount > 0 || updatedCount > 0 || wsModified)
  ) {
    try {
      const pidFile = path.join(paseoHome, "paseo.pid");
      const anyRunning = [...existingBySid.values()].some(
        (entry) => entry?.record?.lastStatus === "running",
      );
      if (fs.existsSync(pidFile) && !anyRunning) {
        const runner = resolvePaseoRunner();
        const child = spawn(runner.exe, [...runner.prefixArgs, "daemon", "restart"], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
          shell: runner.shell,
          env: runner.env,
        });
        child.unref();
      }
    } catch {
      // ignore
    }
  }

  if (!quiet) {
    console.log(
      `[boot-presync] 极速预同步完成: 扫描 ${candidates.length} 条会话，新增 ${createdCount} 条，刷新 ${updatedCount} 条`,
    );
  }

  return { skipped: false, createdCount, updatedCount, wsModified };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.bootPresync) {
    await runBootPresync({ quiet: false, throttleMs: 0 });
    return;
  }

  const runner = resolvePaseoRunner();

  console.log("=== Paseo Omni: 官方项目对齐与全量会话同步 (Phase 6) ===");
  const count = await syncOnce(opts, runner, { allowClean: true });
  const totalStored = scanStoredOmniRecords().size;
  console.log(`=== 同步完成（本次新增 ${count} 条，当前 Paseo 共纳管 ${totalStored} 条真实会话） ===`);

  if (opts.watch) {
    const pidFile = path.join(paseoHome, "omni-watcher.pid");
    if (fs.existsSync(pidFile)) {
      try {
        const oldPid = Number.parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
        if (oldPid && oldPid !== process.pid) {
          process.kill(oldPid);
        }
      } catch {
        // 旧进程已退出
      }
    }
    writeJsonAtomicSync(pidFile, process.pid);
    console.log(
      `[watch] 正在每 ${opts.intervalSec} 秒持续监听 Codex / Antigravity / ZCode / DSH 新会话与外部更新 (PID: ${process.pid})...`,
    );
    setInterval(() => {
      syncOnce(opts, runner, { allowClean: false }).catch((err) => {
        console.error("[watch] 增量同步异常:", err);
      });
    }, opts.intervalSec * 1000);
  }
}

const isDirectMain =
  process.argv[1] &&
  import.meta.url.toLowerCase() === pathToFileURL(path.resolve(process.argv[1])).href.toLowerCase();

if (isDirectMain) {
  main().catch((err) => {
    console.error("会话同步失败:", err);
    process.exit(1);
  });
}
