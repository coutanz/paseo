/**
 * Paseo Omni — 四大桌面 Agent 官方项目目录映射、App 级原生直连与无损历史提取核心模块
 *
 * 核心能力（Phase 6 — Project-First + Option B 自由对话收件箱 + 原生 App 桥接）：
 *   1. 官方项目优先映射 (`loadCanonicalProjectCatalog` + `resolveSessionProjectPlacement`)：
 *      - 严格读取 Codex (`~/.codex/.codex-global-state.json` + `state_5.sqlite`) 与
 *        ZCode (`~/.zcode/v2/tasks-index.sqlite`) 的官方 `projects` / `project_roots` 注册表；
 *      - 自动将多子仓库（如 `90CN-Server`、`90CN-ClientPatch`、`90CN-PVF`）与 Git Worktrees
 *        （如 `worktrees/* /90CN-Server`、`worktrees/* /arad40`）归并到唯一主项目（`90CN`、`JP40` 等）；
 *      - 采用方式 B：所有未绑定项目的随手新建会话（`new-chat*`、`draft-*`、`default-workspace` 等）
 *        按客户端归入 4 个专属收件箱项目：`Codex 自由对话`、`Antigravity 自由对话`、`ZCode 自由对话`、`DSH 自由对话`，
 *        同时保留每条会话的 `realCwd` 供续接对话时在原目录执行工具。
 *   2. 严苛噪音与子代理过滤：
 *      - Codex：剔除 `source LIKE '%subagent%'`（含 106 个 `thread_spawn` 子代理与 18 个 `guardian` 自动审查子代理）、
 *        `source = 'exec'` 脚本任务以及 `CodexBridgeService` 后台探测会话；
 *      - Antigravity：仅纳管桌面端真实会话，剔除 `antigravity-cli`、空会话与后台探测会话；
 *      - ZCode & DSH：严格对齐桌面端 `tasks-index.sqlite` 与 `session_projcache`。
 *   3. 原生 App 直连辅助：
 *      - Antigravity Desktop ConnectRPC (`discoverAntigravityLanguageServer` / `callAntigravityRpc`)
 *      - DSH Desktop Cordis 进程内直连 (`discoverDshDesktopConnector` / `callDshDesktopConnector`)
 *      - ZCode Desktop Provider Config 环境变量解析与 `tasks-index.sqlite` 双向回写
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const isWin = process.platform === "win32";
const homeDir = os.homedir();
const paseoHome = process.env.PASEO_HOME || path.join(homeDir, ".paseo");

export const CLIENT_INBOX_NAMES = {
  codex: "Codex 自由对话",
  "codex-desktop": "Codex 自由对话",
  antigravity: "Antigravity 自由对话",
  zcode: "ZCode 自由对话",
  dsh: "DSH 自由对话",
};

export function stripWinExtendedPrefix(rawPath) {
  if (!rawPath || typeof rawPath !== "string") return "";
  return rawPath.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "");
}

export function ensureExistingDir(candidate) {
  if (candidate && typeof candidate === "string") {
    let resolved = candidate.trim();
    if (resolved.startsWith("[")) {
      try {
        const arr = JSON.parse(resolved);
        if (Array.isArray(arr) && arr[0]) resolved = String(arr[0]);
      } catch {
        // 忽略非 JSON 数组字符串
      }
    }
    if (resolved.startsWith("file://")) {
      try {
        resolved = fileURLToPath(resolved);
      } catch {
        // 忽略非法 file URI
      }
    }
    resolved = stripWinExtendedPrefix(resolved);
    try {
      if (resolved && fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        return path.resolve(resolved);
      }
    } catch {
      // 目录不存在时回退主目录
    }
  }
  return homeDir;
}

export function getClientInboxProject(provider) {
  const inboxName = CLIENT_INBOX_NAMES[provider] || CLIENT_INBOX_NAMES.codex;
  const inboxDir = path.join(paseoHome, "inboxes", inboxName);
  try {
    fs.mkdirSync(inboxDir, { recursive: true });
  } catch {
    // ignore
  }
  return {
    projectName: inboxName,
    projectCwd: path.resolve(inboxDir),
  };
}

function normalizeIsoTimestamp(value, fallbackMs = Date.now()) {
  if (value === null || value === undefined || value === "") {
    return new Date(fallbackMs).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value < 1e11 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (typeof value === "bigint") {
    const num = Number(value);
    const ms = num < 1e11 ? num * 1000 : num > 1e14 ? Math.floor(num / 1e6) : num;
    return new Date(ms).toISOString();
  }
  const str = String(value).trim();
  if (/^\d+$/.test(str)) {
    const num = Number(str);
    const ms = num < 1e11 ? num * 1000 : num;
    return new Date(ms).toISOString();
  }
  const parsed = Date.parse(str);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }
  return new Date(fallbackMs).toISOString();
}

function findLatestCodexStateDb() {
  const codexRoot = path.join(homeDir, ".codex");
  if (!fs.existsSync(codexRoot)) return null;
  const candidates = fs
    .readdirSync(codexRoot)
    .filter((f) => /^state_\d+\.sqlite$/i.test(f))
    .map((f) => {
      const ver = Number.parseInt(f.match(/\d+/)?.[0] || "0", 10);
      return { ver, fullPath: path.join(codexRoot, f) };
    })
    .sort((a, b) => b.ver - a.ver);
  return candidates[0]?.fullPath || null;
}

// ============================================================================
// 官方项目注册表与方式 B 自由对话收件箱映射 (`loadCanonicalProjectCatalog`)
// ============================================================================
let cachedCatalog = null;
let cachedCatalogAt = 0;

export function loadCanonicalProjectCatalog({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedCatalog && Date.now() - cachedCatalogAt < 10_000) {
    return cachedCatalog;
  }

  const projectsById = new Map();
  const projectsByNameLower = new Map();
  const codexThreadAssignments = new Map();
  const codexProjectlessSet = new Set();

  const registerCanonicalProject = ({ id, name, rootPaths }) => {
    const cleanName = String(name || "").trim();
    if (!cleanName) return;
    const validRoots = [];
    for (const rp of rootPaths || []) {
      const stripped = stripWinExtendedPrefix(String(rp || "").trim());
      if (stripped) validRoots.push(path.resolve(stripped));
    }
    if (validRoots.length === 0) return;

    // 优先选择磁盘上实际存在的首个根目录作为 Paseo 工作区主路径
    const existingRoot = validRoots.find((r) => {
      try {
        return fs.existsSync(r) && fs.statSync(r).isDirectory();
      } catch {
        return false;
      }
    });
    const primaryCwd = existingRoot || validRoots[0];
    const keyLower = cleanName.toLowerCase();

    const existing = projectsByNameLower.get(keyLower);
    if (existing) {
      for (const r of validRoots) {
        if (!existing.rootPaths.some((er) => er.toLowerCase() === r.toLowerCase())) {
          existing.rootPaths.push(r);
        }
      }
      if (!fs.existsSync(existing.primaryCwd) && existingRoot) {
        existing.primaryCwd = existingRoot;
      }
      if (id) projectsById.set(String(id), existing);
      return;
    }

    const record = {
      id: id ? String(id) : `proj-${keyLower}`,
      name: cleanName,
      primaryCwd,
      rootPaths: validRoots,
    };
    projectsByNameLower.set(keyLower, record);
    if (id) projectsById.set(String(id), record);
  };

  // 1. 读取 Codex `.codex-global-state.json`
  const codexGlobalJson = path.join(homeDir, ".codex", ".codex-global-state.json");
  if (fs.existsSync(codexGlobalJson)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(codexGlobalJson, "utf8"));
      const rawLocalProjects = parsed?.["local-projects"];
      const localProjects = Array.isArray(rawLocalProjects)
        ? rawLocalProjects
        : rawLocalProjects && typeof rawLocalProjects === "object"
          ? Object.values(rawLocalProjects)
          : [];
      for (const lp of localProjects) {
        if (lp?.id && lp?.name && Array.isArray(lp?.rootPaths)) {
          registerCanonicalProject({
            id: lp.id,
            name: lp.name,
            rootPaths: lp.rootPaths,
          });
        }
      }
      const assignments = parsed?.["thread-project-assignments"];
      if (assignments && typeof assignments === "object") {
        for (const [tid, assign] of Object.entries(assignments)) {
          if (assign?.projectId) {
            codexThreadAssignments.set(String(tid), String(assign.projectId));
          }
        }
      }
      const projectless = parsed?.["projectless-thread-ids"];
      if (Array.isArray(projectless)) {
        for (const tid of projectless) {
          codexProjectlessSet.add(String(tid));
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. 读取 Codex `state_5.sqlite` (`projects` + `project_roots`)
  const codexDbPath = findLatestCodexStateDb();
  if (codexDbPath && fs.existsSync(codexDbPath)) {
    let db;
    try {
      db = new DatabaseSync(codexDbPath, { open: true, readOnly: true });
      const projs = db.prepare("SELECT id, name FROM projects ORDER BY position ASC").all();
      const roots = db
        .prepare("SELECT project_id, path FROM project_roots ORDER BY position ASC")
        .all();
      const rootsByProj = new Map();
      for (const r of roots) {
        const pid = String(r.project_id);
        if (!rootsByProj.has(pid)) rootsByProj.set(pid, []);
        rootsByProj.get(pid).push(String(r.path));
      }
      for (const p of projs) {
        const pid = String(p.id);
        registerCanonicalProject({
          id: pid,
          name: String(p.name),
          rootPaths: rootsByProj.get(pid) || [],
        });
      }
    } catch {
      // ignore
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  }

  // 3. 读取 ZCode `~/.zcode/v2/tasks-index.sqlite` (`projects` + `project_roots`)
  const zcodeTasksDb = path.join(homeDir, ".zcode", "v2", "tasks-index.sqlite");
  if (fs.existsSync(zcodeTasksDb)) {
    let db;
    try {
      db = new DatabaseSync(zcodeTasksDb, { open: true, readOnly: true });
      const projs = db
        .prepare("SELECT project_id, name FROM projects WHERE deleted = 0 ORDER BY position ASC")
        .all();
      const roots = db
        .prepare(
          "SELECT project_id, root_path FROM project_roots ORDER BY is_primary DESC, position ASC",
        )
        .all();
      const rootsByProj = new Map();
      for (const r of roots) {
        const pid = String(r.project_id);
        if (!rootsByProj.has(pid)) rootsByProj.set(pid, []);
        rootsByProj.get(pid).push(String(r.root_path));
      }
      for (const p of projs) {
        const pid = String(p.project_id);
        registerCanonicalProject({
          id: pid,
          name: String(p.name),
          rootPaths: rootsByProj.get(pid) || [],
        });
      }
    } catch {
      // ignore
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  }

  // 构建按路径长度降序排列的根目录前缀匹配表（确保 `E:\client\ARAD40E` 优先于 `E:\client`）
  const rootPrefixEntries = [];
  const rootBasenameMap = new Map();
  for (const proj of projectsByNameLower.values()) {
    for (const rp of proj.rootPaths) {
      const norm = path.resolve(rp).toLowerCase();
      rootPrefixEntries.push({ normRoot: norm, project: proj });
      const base = path.basename(norm);
      if (base && !rootBasenameMap.has(base)) {
        rootBasenameMap.set(base, proj);
      }
    }
  }
  rootPrefixEntries.sort((a, b) => b.normRoot.length - a.normRoot.length);

  cachedCatalog = {
    projectsById,
    projectsByNameLower,
    rootPrefixEntries,
    rootBasenameMap,
    codexThreadAssignments,
    codexProjectlessSet,
  };
  cachedCatalogAt = Date.now();
  return cachedCatalog;
}

function isAdhocScratchDirectory(rawPath) {
  if (!rawPath) return true;
  const norm = path.resolve(stripWinExtendedPrefix(rawPath)).toLowerCase();
  const normHome = path.resolve(homeDir).toLowerCase();
  if (norm === normHome) return true;
  return (
    norm.includes("\\documents\\codex\\") ||
    norm.includes("\\codexdata\\documents-codex\\") ||
    norm.includes("\\.zcode\\workspace\\") ||
    norm.includes("\\.dsh\\default-workspace") ||
    norm.includes("\\.gemini\\antigravity\\scratch") ||
    norm.includes("\\codexbridgeservice\\")
  );
}

/**
 * 将任意会话归类到官方项目或方式 B 的 4 个客户端专属收件箱项目
 */
export function resolveSessionProjectPlacement({ provider, sessionId, rawCwd, projectId = null }) {
  const catalog = loadCanonicalProjectCatalog();
  const realCwd = ensureExistingDir(rawCwd);
  const cleanedRaw = stripWinExtendedPrefix(String(rawCwd || "").trim());
  const normRaw = cleanedRaw ? path.resolve(cleanedRaw).toLowerCase() : "";

  // 1. Codex 明确标记为无项目的自由对话 (`projectless-thread-ids`)
  if (
    (provider === "codex" || provider === "codex-desktop") &&
    sessionId &&
    catalog.codexProjectlessSet.has(String(sessionId))
  ) {
    const inbox = getClientInboxProject(provider);
    return {
      projectName: inbox.projectName,
      projectCwd: inbox.projectCwd,
      realCwd,
      isInbox: true,
    };
  }

  // 2. 显式 Project ID 绑定（ZCode `project_id` 或 Codex `thread-project-assignments`）
  const effectiveProjectId =
    projectId ||
    ((provider === "codex" || provider === "codex-desktop") && sessionId
      ? catalog.codexThreadAssignments.get(String(sessionId))
      : null);
  if (effectiveProjectId && catalog.projectsById.has(String(effectiveProjectId))) {
    const proj = catalog.projectsById.get(String(effectiveProjectId));
    return {
      projectName: proj.name,
      projectCwd: proj.primaryCwd,
      realCwd,
      isInbox: false,
    };
  }

  // 3. Git Worktree 路径自动归并（例如 `.codex\worktrees\ef38\90CN-Server` -> `90CN`，`arad40` -> `JP40`）
  const wtMatch = /[\\/]worktrees[\\/][^\\/]+[\\/]([^\\/]+)/i.exec(cleanedRaw);
  if (wtMatch) {
    const repoBase = wtMatch[1].toLowerCase();
    const matchedProj =
      catalog.rootBasenameMap.get(repoBase) || catalog.projectsByNameLower.get(repoBase);
    if (matchedProj) {
      return {
        projectName: matchedProj.name,
        projectCwd: matchedProj.primaryCwd,
        realCwd,
        isInbox: false,
      };
    }
  }

  // 4. 若属于客户端默认临时目录（如 `Documents\Codex\...\new-chat`、`.zcode\workspace\default`），直接进入方式 B 收件箱
  if (isAdhocScratchDirectory(cleanedRaw || realCwd)) {
    const inbox = getClientInboxProject(provider);
    return {
      projectName: inbox.projectName,
      projectCwd: inbox.projectCwd,
      realCwd,
      isInbox: true,
    };
  }

  // 5. 最长路径前缀匹配官方项目根目录（例如 `E:\client\ARAD40E` 优先命中 `ARAD40E`，`D:\hirokun-DNF\cn90\90CN-PVF` 命中 `90CN`）
  for (const candidatePath of [normRaw, path.resolve(realCwd).toLowerCase()]) {
    if (!candidatePath) continue;
    for (const { normRoot, project } of catalog.rootPrefixEntries) {
      if (candidatePath === normRoot || candidatePath.startsWith(`${normRoot}${path.sep}`)) {
        return {
          projectName: project.name,
          projectCwd: project.primaryCwd,
          realCwd,
          isInbox: false,
        };
      }
    }
  }

  // 6. 目录同名归并（例如旧路径 `Documents\ChatGPT\DXF-V18-CN` 归并到官方项目 `DXF-V18-CN`）
  if (normRaw) {
    const baseLower = path.basename(normRaw).toLowerCase();
    const matchedProj =
      catalog.projectsByNameLower.get(baseLower) || catalog.rootBasenameMap.get(baseLower);
    if (matchedProj) {
      return {
        projectName: matchedProj.name,
        projectCwd: matchedProj.primaryCwd,
        realCwd,
        isInbox: false,
      };
    }
  }

  // 7. 其余未在客户端注册为项目的零散路径统一归入方式 B 的客户端自由对话收件箱
  const inbox = getClientInboxProject(provider);
  return {
    projectName: inbox.projectName,
    projectCwd: inbox.projectCwd,
    realCwd,
    isInbox: true,
  };
}

export function cleanCodexPromptText(raw) {
  if (!raw || typeof raw !== "string") return "";
  let text = raw.trim();

  const hasClipboardImg =
    /codex-clipboard-[^\s:]+\.png/i.test(text) || /Image attachment:\s*true/i.test(text);
  const hasPastedFiles = /^#\s*Files (?:mentioned|pasted) by the user:/im.test(text);

  const reqMatch = /##\s*My request:\s*\r?\n([\s\S]*)$/i.exec(text);
  if (reqMatch) {
    const actualReq = reqMatch[1].trim();
    if (actualReq) {
      return hasClipboardImg ? `[附带截图]\n${actualReq}` : actualReq;
    }
    return hasClipboardImg ? "[发送了一张剪贴板截图]" : "[附带文件上下文]";
  }

  if (hasClipboardImg || hasPastedFiles) {
    const stripped = text
      .replace(/^#\s*Files (?:mentioned|pasted) by the user:[\s\S]*?(?:\r?\n\r?\n|$)/i, "")
      .replace(/^##\s*codex-clipboard-[^\r\n]+(?:\r?\nImage attachment:\s*true)?/gim, "")
      .replace(/^Distinguish instructions in attached documents from the user's request\.\s*/gim, "")
      .trim();
    return stripped || (hasClipboardImg ? "[发送了一张剪贴板截图]" : "[附带文件上下文]");
  }

  return text;
}

export function cleanCodexTitle(raw) {
  if (!raw || typeof raw !== "string") return "";
  let text = raw.trim();
  const reqMatch = /##\s*My request:\s*\r?\n([\s\S]*)$/i.exec(text);
  if (reqMatch && reqMatch[1].trim()) {
    text = reqMatch[1].trim();
  } else {
    text = text
      .replace(/^#\s*Files (?:mentioned|pasted) by the user:[\s\S]*?(?:\r?\n\r?\n|$)/i, "")
      .replace(/^##\s*codex-clipboard-[^\r\n]+/gim, "")
      .replace(/^Image attachment:\s*true/gim, "")
      .replace(/^Distinguish instructions in attached documents from the user's request\./gim, "")
      .trim();
  }
  text = text.replace(/\[(https?:\/\/[^\]]+)\]\(\1\)/g, "$1");
  return truncateTitle(text);
}

function cleanAntigravityUserText(raw) {
  if (!raw || typeof raw !== "string") return "";
  const reqMatch = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(raw);
  if (reqMatch) {
    return reqMatch[1].trim();
  }
  if (
    raw.includes("<CONTEXT_SUMMARY>") ||
    raw.startsWith("Error: The stream was interrupted.")
  ) {
    return "";
  }
  return raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .trim();
}

function isSyntheticPromptNoise(text) {
  if (!text) return true;
  const t = text.trim();
  return (
    t.startsWith("Available agent types for the Agent tool:") ||
    t.startsWith("<system-reminder>") ||
    t.startsWith("<environment_context>") ||
    t.startsWith("<permissions instructions>") ||
    t.startsWith("<collaboration_mode>") ||
    t.startsWith("# AGENTS.md instructions") ||
    t.startsWith("<turn_aborted>") ||
    t.startsWith("Generate metadata for a coding agent based on the user prompt.") ||
    t === "Reply with exactly: PASEO-CODEX-OK" ||
    t.startsWith("Time sampled while preparing turn ") ||
    t.startsWith("Current runtime context. This snapshot supersedes") ||
    t.startsWith("The approval policy changed from ") ||
    /^background job [a-z0-9_-]+\s*\(/i.test(t)
  );
}

export function truncateTitle(text, maxLen = 72) {
  const cleaned = String(text || "")
    .replace(/\[(https?:\/\/[^\]]+)\]\(\1\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "未命名会话";
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
}

function readTailLines(filePath, maxBytes = 8 * 1024 * 1024) {
  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) {
    return fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  }
  const fd = fs.openSync(filePath, "r");
  try {
    const startOffset = stat.size - maxBytes;
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, startOffset);
    const text = buf.toString("utf8");
    const firstNewline = text.indexOf("\n");
    const aligned = firstNewline !== -1 ? text.slice(firstNewline + 1) : text;
    return aligned.split(/\r?\n/);
  } finally {
    fs.closeSync(fd);
  }
}

function walkJsonlFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonlFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      try {
        const stat = fs.statSync(full);
        out.push({ path: full, name: entry.name, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs });
      } catch {
        // 忽略无法读取的文件
      }
    }
  }
  return out;
}

// ============================================================================
// 1. OpenAI Codex (`~/.codex/state_*.sqlite` + `session_index.jsonl`)
// ============================================================================
function loadCodexSessionIndexTitles() {
  const map = new Map();
  const idxPath = path.join(homeDir, ".codex", "session_index.jsonl");
  if (!fs.existsSync(idxPath)) return map;
  try {
    const lines = fs.readFileSync(idxPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.id && typeof obj.thread_name === "string" && obj.thread_name.trim()) {
          map.set(String(obj.id), obj.thread_name.trim());
        }
      } catch {
        // 忽略单行解析异常
      }
    }
  } catch {
    // 忽略读取异常
  }
  return map;
}

export function listCodexSessions({ limit = Infinity, includeArchived = false } = {}) {
  const titleIndex = loadCodexSessionIndexTitles();
  const stateDbPath = findLatestCodexStateDb();

  if (stateDbPath && fs.existsSync(stateDbPath)) {
    let db;
    try {
      db = new DatabaseSync(stateDbPath, { open: true, readOnly: true });
      const sql = `
        SELECT id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
               cwd, title, first_user_message, name, model, archived, agent_role, source
        FROM threads
        WHERE (agent_role IS NULL OR agent_role = '')
          AND (source IS NULL OR (source NOT LIKE '%subagent%' AND source != 'exec'))
          AND (cwd IS NULL OR cwd NOT LIKE '%CodexBridgeService%')
          ${includeArchived ? "" : "AND archived = 0"}
        ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC
      `;
      const rows = db.prepare(sql).all();
      const results = [];

      for (const row of rows) {
        if (results.length >= limit) break;
        const id = String(row.id || "");
        if (!id) continue;

        const rawFirst = String(row.first_user_message || row.title || "").trim();
        if (
          rawFirst === "Reply with exactly: PASEO-CODEX-OK" ||
          rawFirst.startsWith("Generate metadata for a coding agent based on the user prompt.")
        ) {
          continue;
        }

        const indexedTitle = titleIndex.get(id) || (row.name ? String(row.name).trim() : "");
        const finalTitle = indexedTitle
          ? truncateTitle(indexedTitle)
          : cleanCodexTitle(row.title || row.first_user_message || id) || id;

        const placement = resolveSessionProjectPlacement({
          provider: "codex",
          sessionId: id,
          rawCwd: row.cwd ? String(row.cwd) : "",
        });
        const createdAt = normalizeIsoTimestamp(row.created_at_ms ?? row.created_at);
        const updatedAt = normalizeIsoTimestamp(row.updated_at_ms ?? row.updated_at);
        const rolloutPath = stripWinExtendedPrefix(String(row.rollout_path || ""));

        results.push({
          provider: "codex",
          sessionId: id,
          cwd: placement.projectCwd,
          realCwd: placement.realCwd,
          projectName: placement.projectName,
          isInbox: placement.isInbox,
          title: finalTitle,
          createdAt,
          updatedAt,
          model: row.model ? String(row.model) : null,
          filePath: rolloutPath || null,
        });
      }
      return results;
    } catch {
      // SQLite 读取失败时回退到文件扫描
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  }

  return [];
}

function findCodexRolloutPath(sessionId) {
  const stateDbPath = findLatestCodexStateDb();
  if (stateDbPath && fs.existsSync(stateDbPath)) {
    let db;
    try {
      db = new DatabaseSync(stateDbPath, { open: true, readOnly: true });
      const row = db
        .prepare("SELECT rollout_path, title, name, updated_at, updated_at_ms FROM threads WHERE id = ?")
        .get(sessionId);
      if (row?.rollout_path) {
        const rp = stripWinExtendedPrefix(String(row.rollout_path));
        if (fs.existsSync(rp)) {
          return {
            path: rp,
            title: row.name ? String(row.name) : cleanCodexTitle(String(row.title || "")),
            updatedAt: normalizeIsoTimestamp(row.updated_at_ms ?? row.updated_at),
          };
        }
      }
    } catch {
      // ignore
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  }

  const sessionsRoot = path.join(homeDir, ".codex", "sessions");
  const files = walkJsonlFiles(sessionsRoot).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const match = files.find((f) => f.name.includes(sessionId));
  if (!match) return null;
  return {
    path: match.path,
    title: null,
    updatedAt: new Date(match.mtimeMs).toISOString(),
  };
}

export function loadCodexHistory(sessionId, maxMessages = 200) {
  const titleIndex = loadCodexSessionIndexTitles();
  const found = findCodexRolloutPath(sessionId);
  if (!found) return { title: titleIndex.get(sessionId) || null, updatedAt: null, messages: [] };

  const rawTurns = [];
  let currentTurn = null;
  let firstUserPrompt = "";

  try {
    const lines = readTailLines(found.path, 8 * 1024 * 1024);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx];
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }

      if (obj.type === "event_msg" && obj.payload?.type === "user_message" && obj.payload.message) {
        const rawText = String(obj.payload.message).trim();
        if (isSyntheticPromptNoise(rawText)) continue;
        const cleaned = cleanCodexPromptText(rawText);
        if (!cleaned) continue;
        if (!firstUserPrompt) firstUserPrompt = cleaned;
        if (currentTurn) rawTurns.push(currentTurn);
        currentTurn = {
          userId: `cdx-u-${idx}`,
          userText: cleaned,
          assistantMsgs: [],
          thoughts: [],
        };
      } else if (
        obj.type === "event_msg" &&
        obj.payload?.type === "agent_message" &&
        obj.payload.message
      ) {
        const text = String(obj.payload.message).trim();
        if (!text) continue;
        if (!currentTurn) {
          currentTurn = { userId: null, userText: "", assistantMsgs: [], thoughts: [] };
        }
        currentTurn.assistantMsgs.push({ id: `cdx-a-${idx}`, text });
      } else if (
        obj.type === "event_msg" &&
        obj.payload?.type === "agent_reasoning" &&
        obj.payload.text
      ) {
        if (currentTurn) currentTurn.thoughts.push(String(obj.payload.text).trim());
      }
    }
    if (currentTurn) rawTurns.push(currentTurn);
  } catch {
    // ignore
  }

  const messages = [];
  for (const turn of rawTurns) {
    if (turn.userText) {
      messages.push({ id: turn.userId, role: "user", text: turn.userText });
    }
    if (turn.assistantMsgs.length > 0) {
      const finalMsg = turn.assistantMsgs[turn.assistantMsgs.length - 1];
      const interimSteps = turn.assistantMsgs.slice(0, -1).map((m) => m.text);
      const allThoughts = [...turn.thoughts, ...interimSteps].filter(Boolean).join("\n\n");
      messages.push({
        id: finalMsg.id,
        role: "assistant",
        text: finalMsg.text,
        thinking: allThoughts,
      });
    }
  }

  const finalTitle =
    titleIndex.get(sessionId) ||
    found.title ||
    (firstUserPrompt ? cleanCodexTitle(firstUserPrompt) : sessionId);

  return {
    title: truncateTitle(finalTitle),
    updatedAt: found.updatedAt,
    messages: messages.slice(-maxMessages),
  };
}

// ============================================================================
// 2. Google Antigravity (`conversation_summaries.db` + `transcript_full.jsonl` + Live RPC)
// ============================================================================
let cachedAntigravityLs = null;
let cachedAntigravityLsAt = 0;

export function postAntigravityRpc(port, csrf, method, body = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        method: "POST",
        timeout: timeoutMs,
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          "x-codeium-csrf-token": csrf,
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("Antigravity RPC timeout"));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

export async function discoverAntigravityLanguageServer({ forceRefresh = false } = {}) {
  if (!forceRefresh && cachedAntigravityLs && Date.now() - cachedAntigravityLsAt < 30_000) {
    return cachedAntigravityLs;
  }

  try {
    let candidates = [];
    if (isWin) {
      const psCmd =
        "Get-CimInstance Win32_Process -Filter \"Name = 'language_server.exe'\" | " +
        "ForEach-Object { $p = $_.ProcessId; $ports = @(Get-NetTCPConnection -OwningProcess $p -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort); " +
        "[pscustomobject]@{ pid=$p; cmd=$_.CommandLine; ports=$ports } } | ConvertTo-Json -Compress";
      const out = execFileSync("powershell", ["-NoProfile", "-Command", psCmd], {
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true,
      }).trim();
      if (out) {
        const parsed = JSON.parse(out);
        candidates = Array.isArray(parsed) ? parsed : [parsed];
      }
    } else {
      const psOut = execFileSync("ps", ["-ax", "-o", "pid=,command="], {
        encoding: "utf8",
        timeout: 3000,
      });
      for (const line of psOut.split(/\r?\n/)) {
        if (!line.includes("language_server") || !line.includes("--csrf_token")) continue;
        const m = /^\s*(\d+)\s+(.*)$/.exec(line);
        if (!m) continue;
        const pid = Number(m[1]);
        const cmd = m[2];
        try {
          const lsofOut = execFileSync("lsof", ["-Pan", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"], {
            encoding: "utf8",
            timeout: 2000,
          });
          const ports = [];
          for (const ll of lsofOut.split(/\r?\n/)) {
            const pm = /:(\d+)\s+\(LISTEN\)/.exec(ll);
            if (pm) ports.push(Number(pm[1]));
          }
          candidates.push({ pid, cmd, ports });
        } catch {
          // ignore
        }
      }
    }

    for (const proc of candidates) {
      const cmd = String(proc?.cmd || "");
      const csrfMatch = /--csrf_token[=\s]+([^\s"]+)/.exec(cmd);
      if (!csrfMatch) continue;
      const csrf = csrfMatch[1];
      const ports = Array.isArray(proc.ports) ? proc.ports : [];

      for (const port of ports) {
        try {
          await postAntigravityRpc(Number(port), csrf, "GetAllCascadeTrajectories", {}, 1500);
          cachedAntigravityLs = { port: Number(port), csrf, pid: proc.pid };
          cachedAntigravityLsAt = Date.now();
          return cachedAntigravityLs;
        } catch {
          // 尝试下一个监听端口
        }
      }
    }
  } catch {
    // 桌面端未启动时静默返回 null
  }

  cachedAntigravityLs = null;
  return null;
}

export async function callAntigravityRpc(method, body = {}, timeoutMs = 10_000) {
  let ls = await discoverAntigravityLanguageServer();
  if (!ls) return null;
  try {
    return await postAntigravityRpc(ls.port, ls.csrf, method, body, timeoutMs);
  } catch {
    ls = await discoverAntigravityLanguageServer({ forceRefresh: true });
    if (!ls) return null;
    return await postAntigravityRpc(ls.port, ls.csrf, method, body, timeoutMs);
  }
}

function findAntigravityTranscriptPath(sessionId) {
  const candidates = [
    path.join(
      homeDir,
      ".gemini",
      "antigravity",
      "brain",
      sessionId,
      ".system_generated",
      "logs",
      "transcript_full.jsonl",
    ),
    path.join(
      homeDir,
      ".gemini",
      "antigravity",
      "brain",
      sessionId,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    ),
    path.join(
      homeDir,
      ".gemini",
      "antigravity-cli",
      "brain",
      sessionId,
      ".system_generated",
      "logs",
      "transcript_full.jsonl",
    ),
    path.join(
      homeDir,
      ".gemini",
      "antigravity-cli",
      "brain",
      sessionId,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    ),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function isAntigravityCliNativeSession(sessionId) {
  const cliDb = path.join(
    homeDir,
    ".gemini",
    "antigravity-cli",
    "conversations",
    `${sessionId}.db`,
  );
  return fs.existsSync(cliDb);
}

export function isAntigravityDesktopSession(sessionId) {
  const desktopDb = path.join(
    homeDir,
    ".gemini",
    "antigravity",
    "conversations",
    `${sessionId}.db`,
  );
  return fs.existsSync(desktopDb);
}

export function listAntigravitySessions({ limit = Infinity } = {}) {
  const byId = new Map();

  // 仅从桌面端 `antigravity/conversation_summaries.db` 读取用户真实会话（剔除 `antigravity-cli`、子代理与空会话）
  const dbPath = path.join(homeDir, ".gemini", "antigravity", "conversation_summaries.db");
  if (fs.existsSync(dbPath)) {
    let db;
    try {
      db = new DatabaseSync(dbPath, { open: true, readOnly: true });
      const rows = db
        .prepare(
          `SELECT conversation_id, title, preview, step_count, last_modified_time,
                  last_user_input_time, workspace_uris, parent_conversation_id,
                  nesting_depth, killed
           FROM conversation_summaries
           WHERE (parent_conversation_id IS NULL OR parent_conversation_id = '')
             AND (nesting_depth IS NULL OR nesting_depth = 0)
             AND (killed IS NULL OR killed = 0)
           ORDER BY last_modified_time DESC`,
        )
        .all();

      for (const r of rows) {
        const id = String(r.conversation_id || "").trim();
        if (!id) continue;

        // Antigravity 桌面端 UI 发起的真实用户会话均具备非空 title；
        // 无 title 的记录为 2 步中断草稿或 CodexBridge 后台无头探测任务
        const uiTitle = String(r.title || "").trim();
        if (!uiTitle) continue;

        const rawWs = r.workspace_uris ? String(r.workspace_uris) : "";
        if (rawWs.includes("CodexBridgeService")) continue;

        const updatedAt = normalizeIsoTimestamp(r.last_modified_time || r.last_user_input_time);
        const placement = resolveSessionProjectPlacement({
          provider: "antigravity",
          sessionId: id,
          rawCwd: rawWs,
        });

        byId.set(id, {
          provider: "antigravity",
          sessionId: id,
          cwd: placement.projectCwd,
          realCwd: placement.realCwd,
          projectName: placement.projectName,
          isInbox: placement.isInbox,
          title: truncateTitle(cleanAntigravityUserText(uiTitle) || uiTitle),
          createdAt: updatedAt,
          updatedAt,
        });
      }
    } catch {
      // ignore
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
  }

  // 补充真实文件创建时间作为 createdAt
  for (const [id, item] of byId.entries()) {
    const tp = findAntigravityTranscriptPath(id);
    if (tp) {
      try {
        const st = fs.statSync(tp);
        if (st.birthtimeMs && st.birthtimeMs < Date.parse(item.updatedAt)) {
          item.createdAt = new Date(st.birthtimeMs).toISOString();
        }
      } catch {
        // ignore
      }
    }
  }

  return [...byId.values()]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit);
}

export function loadAntigravityHistory(sessionId, maxMessages = 200) {
  const transcriptPath = findAntigravityTranscriptPath(sessionId);
  if (!transcriptPath) return [];

  const turns = [];
  let currentTurn = null;

  try {
    const lines = readTailLines(transcriptPath, 8 * 1024 * 1024);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) continue;
      let step;
      try {
        step = JSON.parse(line);
      } catch {
        continue;
      }

      if (step.type === "USER_INPUT") {
        if (step.source && step.source !== "USER_EXPLICIT") continue;
        const cleaned = cleanAntigravityUserText(step.content);
        if (!cleaned) continue;
        if (currentTurn) turns.push(currentTurn);
        currentTurn = {
          userId: `agy-u-${step.step_index ?? i}`,
          userText: cleaned,
          plannerSteps: [],
        };
      } else if (step.type === "PLANNER_RESPONSE") {
        const text = typeof step.content === "string" ? step.content.trim() : "";
        const thinking = typeof step.thinking === "string" ? step.thinking.trim() : "";
        const hasToolCalls = Array.isArray(step.tool_calls) && step.tool_calls.length > 0;
        if (!text && !thinking) continue;
        if (!currentTurn) {
          currentTurn = { userId: null, userText: "", plannerSteps: [] };
        }
        currentTurn.plannerSteps.push({
          id: `agy-a-${step.step_index ?? i}`,
          text,
          thinking,
          hasToolCalls,
        });
      }
    }
    if (currentTurn) turns.push(currentTurn);
  } catch {
    return [];
  }

  const messages = [];
  for (const turn of turns) {
    if (turn.userText) {
      messages.push({ id: turn.userId, role: "user", text: turn.userText });
    }
    const withText = turn.plannerSteps.filter((s) => s.text);
    if (withText.length > 0) {
      const finalStep = withText[withText.length - 1];
      const thoughtParts = [];
      for (const s of turn.plannerSteps) {
        if (s.thinking) thoughtParts.push(s.thinking);
        if (s !== finalStep && s.text) thoughtParts.push(s.text);
      }
      messages.push({
        id: finalStep.id,
        role: "assistant",
        text: finalStep.text,
        thinking: thoughtParts.join("\n\n"),
      });
    }
  }

  return messages.slice(-maxMessages);
}

// ============================================================================
// 3. GLM ZCode (`~/.zcode/v2/tasks-index.sqlite` + `~/.zcode/cli/db/db.sqlite`)
// ============================================================================
export function listZCodeSessions({ limit = Infinity, includeArchived = false } = {}) {
  const cliDbPath = path.join(homeDir, ".zcode", "cli", "db", "db.sqlite");
  const tasksDbPath = path.join(homeDir, ".zcode", "v2", "tasks-index.sqlite");
  if (!fs.existsSync(cliDbPath)) return [];

  let cliDb;
  let tasksDb;
  try {
    cliDb = new DatabaseSync(cliDbPath, { open: true, readOnly: true });
    const sessionsWithMessages = new Set(
      cliDb
        .prepare(
          `SELECT s.id
           FROM session s
           WHERE s.time_deleted IS NULL
             AND EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id)`,
        )
        .all()
        .map((r) => String(r.id)),
    );

    if (fs.existsSync(tasksDbPath)) {
      tasksDb = new DatabaseSync(tasksDbPath, { open: true, readOnly: true });
      const taskRows = tasksDb
        .prepare(
          `SELECT task_id, title, cli_title, workspace_path, root_path, project_id, created_at, updated_at
           FROM tasks
           WHERE deleted = 0
             AND (cli_deleted IS NULL OR cli_deleted = 0)
             ${includeArchived ? "" : "AND archived = 0"}
           ORDER BY updated_at DESC`,
        )
        .all();

      const results = [];
      for (const row of taskRows) {
        if (results.length >= limit) break;
        const id = String(row.task_id || "");
        if (!id || !sessionsWithMessages.has(id)) continue;
        const rawTitle = String(row.title || row.cli_title || "").trim();
        if (!rawTitle) continue;
        const rawPath = String(row.workspace_path || row.root_path || homeDir);
        const placement = resolveSessionProjectPlacement({
          provider: "zcode",
          sessionId: id,
          rawCwd: rawPath,
          projectId: row.project_id ? String(row.project_id) : null,
        });
        results.push({
          provider: "zcode",
          sessionId: id,
          cwd: placement.projectCwd,
          realCwd: placement.realCwd,
          projectName: placement.projectName,
          isInbox: placement.isInbox,
          title: truncateTitle(rawTitle),
          createdAt: normalizeIsoTimestamp(row.created_at || row.updated_at),
          updatedAt: normalizeIsoTimestamp(row.updated_at),
        });
      }
      return results;
    }

    const rows = cliDb
      .prepare(
        `SELECT s.id, s.directory, s.title, s.time_created, s.time_updated
         FROM session s
         WHERE s.parent_id IS NULL
           AND s.time_deleted IS NULL
           AND EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id)
         ORDER BY s.time_updated DESC`,
      )
      .all();

    return rows.slice(0, limit).map((row) => {
      const id = String(row.id);
      const placement = resolveSessionProjectPlacement({
        provider: "zcode",
        sessionId: id,
        rawCwd: String(row.directory || homeDir),
      });
      return {
        provider: "zcode",
        sessionId: id,
        cwd: placement.projectCwd,
        realCwd: placement.realCwd,
        projectName: placement.projectName,
        isInbox: placement.isInbox,
        title: truncateTitle(row.title || id),
        createdAt: normalizeIsoTimestamp(row.time_created || row.time_updated),
        updatedAt: normalizeIsoTimestamp(row.time_updated),
      };
    });
  } catch {
    return [];
  } finally {
    try {
      tasksDb?.close();
    } catch {
      // ignore
    }
    try {
      cliDb?.close();
    } catch {
      // ignore
    }
  }
}

export function loadZCodeHistory(sessionId, maxMessages = 200) {
  const dbPath = path.join(homeDir, ".zcode", "cli", "db", "db.sqlite");
  if (!fs.existsSync(dbPath)) return [];

  let db;
  try {
    db = new DatabaseSync(dbPath, { open: true, readOnly: true });
    const msgRows = db
      .prepare(
        `SELECT id, data
         FROM message
         WHERE session_id = ?
         ORDER BY time_created ASC`,
      )
      .all(sessionId);

    const partRows = db
      .prepare(
        `SELECT message_id, data
         FROM part
         WHERE session_id = ?
         ORDER BY time_created ASC`,
      )
      .all(sessionId);

    const partsByMsg = new Map();
    for (const p of partRows) {
      const msgId = String(p.message_id);
      if (!partsByMsg.has(msgId)) partsByMsg.set(msgId, []);
      partsByMsg.get(msgId).push(String(p.data));
    }

    const turns = [];
    let currentTurn = null;

    for (const m of msgRows) {
      const msgId = String(m.id);
      let parsedMsg;
      try {
        parsedMsg = JSON.parse(String(m.data));
      } catch {
        continue;
      }

      const role = parsedMsg.role;
      if (role !== "user" && role !== "assistant") continue;

      const sem = parsedMsg.semantics;
      if (role === "user") {
        if (sem?.uiVisibility === "hidden" || sem?.origin === "agent_runtime") {
          continue;
        }
      }

      const rawParts = partsByMsg.get(msgId) || [];
      const textChunks = [];
      const thinkingChunks = [];
      for (const rawPart of rawParts) {
        try {
          const partObj = JSON.parse(rawPart);
          if (partObj.synthetic === true) continue;
          if (partObj.type === "text" && typeof partObj.text === "string") {
            const trimmed = partObj.text.trim();
            if (trimmed && !isSyntheticPromptNoise(trimmed)) {
              textChunks.push(trimmed);
            }
          } else if (
            (partObj.type === "reasoning" || partObj.type === "thinking") &&
            typeof partObj.text === "string" &&
            partObj.text.trim()
          ) {
            thinkingChunks.push(partObj.text.trim());
          }
        } catch {
          // ignore
        }
      }

      const combinedText = textChunks.join("\n\n");
      const combinedThinking = thinkingChunks.join("\n\n");

      if (role === "user") {
        if (!combinedText) continue;
        if (currentTurn) turns.push(currentTurn);
        currentTurn = {
          userId: msgId,
          userText: combinedText,
          assistantSteps: [],
        };
      } else if (combinedText || combinedThinking) {
        if (!currentTurn) {
          currentTurn = { userId: null, userText: "", assistantSteps: [] };
        }
        const isBoundary =
          parsedMsg.finish === "stop" || parsedMsg.anchor?.boundaryMessageId === msgId;
        currentTurn.assistantSteps.push({
          id: msgId,
          text: combinedText,
          thinking: combinedThinking,
          isBoundary,
        });
      }
    }
    if (currentTurn) turns.push(currentTurn);

    const messages = [];
    for (const turn of turns) {
      if (turn.userText) {
        messages.push({ id: turn.userId, role: "user", text: turn.userText });
      }
      const withText = turn.assistantSteps.filter((s) => s.text);
      if (withText.length > 0) {
        const boundarySteps = withText.filter((s) => s.isBoundary);
        const finalStep =
          boundarySteps.length > 0
            ? boundarySteps[boundarySteps.length - 1]
            : withText[withText.length - 1];
        const thoughtParts = [];
        for (const s of turn.assistantSteps) {
          if (s.thinking) thoughtParts.push(s.thinking);
          if (s !== finalStep && s.text) thoughtParts.push(s.text);
        }
        messages.push({
          id: finalStep.id,
          role: "assistant",
          text: finalStep.text,
          thinking: thoughtParts.join("\n\n"),
        });
      }
    }

    return messages.slice(-maxMessages);
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

export function getZCodeSessionTitle(sessionId) {
  const tasksDbPath = path.join(homeDir, ".zcode", "v2", "tasks-index.sqlite");
  if (fs.existsSync(tasksDbPath)) {
    let tdb;
    try {
      tdb = new DatabaseSync(tasksDbPath, { open: true, readOnly: true });
      const row = tdb
        .prepare("SELECT title, cli_title, updated_at FROM tasks WHERE task_id = ?")
        .get(sessionId);
      if (row) {
        return {
          title: truncateTitle(row.title || row.cli_title || sessionId),
          updatedAt: normalizeIsoTimestamp(row.updated_at),
        };
      }
    } catch {
      // ignore
    } finally {
      try {
        tdb?.close();
      } catch {
        // ignore
      }
    }
  }

  const dbPath = path.join(homeDir, ".zcode", "cli", "db", "db.sqlite");
  if (!fs.existsSync(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { open: true, readOnly: true });
    const row = db.prepare("SELECT title, time_updated FROM session WHERE id = ?").get(sessionId);
    if (!row) return null;
    return {
      title: truncateTitle(row.title || sessionId),
      updatedAt: normalizeIsoTimestamp(row.time_updated),
    };
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

export function syncZCodeDesktopTaskIndex({ sessionId, cwd, title, mode = "yolo", model = "GLM-5.3" }) {
  if (!sessionId) return;
  const tasksDbPath = path.join(homeDir, ".zcode", "v2", "tasks-index.sqlite");
  if (!fs.existsSync(tasksDbPath)) return;

  let db;
  try {
    db = new DatabaseSync(tasksDbPath, { open: true, timeout: 3000 });
    const now = Date.now();
    const existing = db.prepare("SELECT task_id FROM tasks WHERE task_id = ?").get(sessionId);
    if (existing) {
      db.prepare(
        `UPDATE tasks
         SET updated_at = ?, cli_updated_at = ?, task_status = 'completed', deleted = 0, archived = 0
         WHERE task_id = ?`,
      ).run(now, now, sessionId);
    } else {
      const wsPath = ensureExistingDir(cwd);
      const cleanTitle = truncateTitle(title || sessionId);
      let projectId = null;
      try {
        const proj = db
          .prepare("SELECT project_id FROM project_roots WHERE LOWER(root_path) = LOWER(?) LIMIT 1")
          .get(wsPath);
        projectId = proj?.project_id || null;
      } catch {
        // ignore
      }
      db.prepare(
        `INSERT INTO tasks (
           workspace_key, workspace_path, task_id, title, cli_title,
           task_status, provider, mode, model, created_at, updated_at,
           pinned, archived, deleted, title_overridden, host_id, root_path,
           project_id, cli_created_at, cli_updated_at, cli_deleted
         ) VALUES (?, ?, ?, ?, ?, 'completed', 'glm', ?, ?, ?, ?, 0, 0, 0, 0, 'local', ?, ?, ?, ?, 0)`,
      ).run(
        wsPath,
        wsPath,
        sessionId,
        cleanTitle,
        cleanTitle,
        mode || "yolo",
        model || "GLM-5.3",
        now,
        now,
        wsPath,
        projectId,
        now,
        now,
      );
    }
  } catch {
    // 若 ZCode 桌面端正短暂锁表则安全跳过
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

// ============================================================================
// 4. DeepSeek Harness (`workspace.json` + `session_projcache` + Cordis 原生直连)
// ============================================================================
export function discoverDshDesktopConnector() {
  const descriptorPath = path.join(paseoHome, "dsh-desktop-connector.json");
  if (!fs.existsSync(descriptorPath)) return null;
  try {
    const desc = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    if (!desc?.port || !desc?.token) return null;
    return {
      host: desc.host || "127.0.0.1",
      port: Number(desc.port),
      token: String(desc.token),
      pid: desc.pid,
    };
  } catch {
    return null;
  }
}

export function callDshDesktopConnector(
  method,
  params = {},
  { onStream = null, timeoutMs = 600_000 } = {},
) {
  const conn = discoverDshDesktopConnector();
  if (!conn) {
    return Promise.reject(new Error("DSH Desktop connector descriptor not found"));
  }

  return new Promise((resolve, reject) => {
    const reqId = randomUUID();
    const socket = net.createConnection({ host: conn.host, port: conn.port });
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(new Error(`DSH Desktop connector timeout (${method})`));
      }
    }, timeoutMs);
    timer.unref?.();

    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({ id: reqId, token: conn.token, method, params })}\n`,
      );
    });

    socket.on("data", (chunk) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "stream" && typeof onStream === "function") {
            onStream(msg);
          } else if (msg.id === reqId) {
            settled = true;
            clearTimeout(timer);
            socket.end();
            if (msg.ok) {
              resolve(msg.result);
            } else {
              reject(new Error(msg.error || "DSH Desktop connector error"));
            }
          }
        } catch {
          // ignore
        }
      }
    });

    socket.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });

    socket.on("close", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error("DSH Desktop connector socket closed before response"));
      }
    });
  });
}

function loadDshArchivedSet() {
  const archived = new Set();
  const wsJson = path.join(homeDir, ".dsh", "storages", "workspace.json");
  if (!fs.existsSync(wsJson)) return archived;
  try {
    const parsed = JSON.parse(fs.readFileSync(wsJson, "utf8"));
    const list = parsed?.global?.archivedSessionIds;
    if (Array.isArray(list)) {
      for (const id of list) archived.add(String(id));
    }
  } catch {
    // ignore
  }
  return archived;
}

function findAllDshSessionFiles() {
  const sessionsRoot = path.join(homeDir, ".dsh", "sessions");
  if (!fs.existsSync(sessionsRoot)) return [];
  const found = [];

  for (const wsEntry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!wsEntry.isDirectory()) continue;
    const wsPath = path.join(sessionsRoot, wsEntry.name);
    for (const sEntry of fs.readdirSync(wsPath, { withFileTypes: true })) {
      if (!sEntry.isDirectory()) continue;
      const zstdFile = path.join(wsPath, sEntry.name, "session.v4.jsonl.zstd");
      if (fs.existsSync(zstdFile)) {
        try {
          const stat = fs.statSync(zstdFile);
          found.push({
            sessionId: sEntry.name,
            zstdFile,
            mtimeMs: stat.mtimeMs,
            birthtimeMs: stat.birthtimeMs,
          });
        } catch {
          // ignore
        }
      }
    }
  }

  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function parseDshZstdFile(zstdFile) {
  if (!fs.existsSync(zstdFile) || typeof zlib.zstdDecompressSync !== "function") {
    return null;
  }
  try {
    const decompressed = zlib.zstdDecompressSync(fs.readFileSync(zstdFile)).toString("utf8");
    const lines = decompressed.split(/\r?\n/);
    let sessionId = null;
    let cwd = homeDir;
    let title = "";
    let parentSession = null;
    let isSubagent = false;

    const turns = [];
    let currentTurn = null;

    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }

      if (evt.type === "session") {
        sessionId = evt.id || sessionId;
        if (evt.cwd) cwd = ensureExistingDir(evt.cwd);
        parentSession = evt.parentSession || null;
      } else if (evt.type === "session/title" && evt.data?.title) {
        title = evt.data.title;
      } else if (evt.type === "subagent/descriptor") {
        isSubagent = true;
      } else if (evt.type === "user/message" && Array.isArray(evt.data?.content)) {
        const sourceKind = evt.data?.source?.kind;
        if (sourceKind && sourceKind !== "user") continue;

        const text = evt.data.content
          .filter((c) => c && c.type === "text" && c.text)
          .map((c) => c.text)
          .join("\n")
          .trim();
        if (!text || isSyntheticPromptNoise(text)) continue;

        if (!sourceKind && (text.startsWith("Current runtime context") || text.startsWith("Time sampled"))) {
          continue;
        }

        if (currentTurn) turns.push(currentTurn);
        currentTurn = {
          userId: evt.data?.id || `dsh-u-${evt.seq ?? turns.length}`,
          userText: text,
          assistantSteps: [],
        };
      } else if (evt.type === "assistant/message" && Array.isArray(evt.data?.message?.content)) {
        const textParts = [];
        const thinkingParts = [];
        for (const c of evt.data.message.content) {
          if (c?.type === "text" && c.text?.trim()) textParts.push(c.text.trim());
          else if (c?.type === "reasoning" && c.text?.trim()) thinkingParts.push(c.text.trim());
        }
        if (textParts.length > 0 || thinkingParts.length > 0) {
          if (!currentTurn) {
            currentTurn = { userId: null, userText: "", assistantSteps: [] };
          }
          currentTurn.assistantSteps.push({
            id: `dsh-a-${evt.seq ?? 0}`,
            text: textParts.join("\n\n"),
            thinking: thinkingParts.join("\n\n"),
          });
        }
      }
    }
    if (currentTurn) turns.push(currentTurn);

    const messages = [];
    for (const turn of turns) {
      if (turn.userText) {
        messages.push({ id: turn.userId, role: "user", text: turn.userText });
      }
      const withText = turn.assistantSteps.filter((s) => s.text);
      if (withText.length > 0) {
        const finalStep = withText[withText.length - 1];
        const thoughtParts = [];
        for (const s of turn.assistantSteps) {
          if (s.thinking) thoughtParts.push(s.thinking);
          if (s !== finalStep && s.text) thoughtParts.push(s.text);
        }
        messages.push({
          id: finalStep.id,
          role: "assistant",
          text: finalStep.text,
          thinking: thoughtParts.join("\n\n"),
        });
      }
    }

    return {
      sessionId,
      cwd,
      title: truncateTitle(title || messages.find((m) => m.role === "user")?.text || sessionId),
      parentSession,
      isSubagent: Boolean(parentSession || isSubagent),
      messages,
    };
  } catch {
    return null;
  }
}

export function listDshSessions({ limit = Infinity, includeArchived = false } = {}) {
  const archivedSet = loadDshArchivedSet();
  const byId = new Map();

  // 1. 优先读取 DSH 桌面端官方投影缓存 (`session_projcache`)
  const cacheDir = path.join(homeDir, ".dsh", "storages", "session_projcache", "sessions");
  if (fs.existsSync(cacheDir)) {
    for (const entry of fs.readdirSync(cacheDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const rawId = entry.name.replace(/\.json$/i, "");
      if (!includeArchived && archivedSet.has(rawId)) continue;

      try {
        const fullPath = path.join(cacheDir, entry.name);
        const stat = fs.statSync(fullPath);
        const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
        const identity = parsed?.record?.identity || {};
        const rows = parsed?.record?.rows || {};

        const isSubagent = Boolean(
          rows.subagentTiming?.val?.descriptorSeen || identity.parentSession,
        );
        const isBlank = Boolean(rows.sessionListMetadata?.val?.blank);
        const turns = rows.turnOutline?.val?.turns || [];
        if (isSubagent || isBlank || turns.length === 0) continue;

        const rawCwd = String(rows.workingDirectory?.val || identity.cwd || "");
        if (rawCwd.includes("CodexBridgeService")) continue;

        const titleVal =
          rows.title?.val ||
          rows.titleInput?.val?.first?.text ||
          turns[0]?.prompt ||
          rawId;
        const placement = resolveSessionProjectPlacement({
          provider: "dsh",
          sessionId: rawId,
          rawCwd,
        });
        const updatedMs =
          rows.timeContext?.val?.lastMessageTime ||
          rows.sessionListMetadata?.val?.lastPromptAt ||
          stat.mtimeMs;
        const createdMs = identity.createdAt || stat.birthtimeMs || updatedMs;

        byId.set(rawId, {
          provider: "dsh",
          sessionId: rawId,
          cwd: placement.projectCwd,
          realCwd: placement.realCwd,
          projectName: placement.projectName,
          isInbox: placement.isInbox,
          title: truncateTitle(titleVal),
          createdAt: normalizeIsoTimestamp(createdMs),
          updatedAt: normalizeIsoTimestamp(updatedMs),
        });
      } catch {
        // ignore
      }
    }
  }

  // 2. 补充扫描 `.jsonl.zstd`
  for (const item of findAllDshSessionFiles()) {
    if (byId.has(item.sessionId)) continue;
    if (!includeArchived && archivedSet.has(item.sessionId)) continue;
    const parsed = parseDshZstdFile(item.zstdFile);
    if (!parsed || parsed.isSubagent || parsed.messages.length === 0) continue;
    if (String(parsed.cwd || "").includes("CodexBridgeService")) continue;
    const sid = parsed.sessionId || item.sessionId;
    if (!includeArchived && archivedSet.has(sid)) continue;
    if (byId.has(sid)) continue;

    const placement = resolveSessionProjectPlacement({
      provider: "dsh",
      sessionId: sid,
      rawCwd: parsed.cwd,
    });

    byId.set(sid, {
      provider: "dsh",
      sessionId: sid,
      cwd: placement.projectCwd,
      realCwd: placement.realCwd,
      projectName: placement.projectName,
      isInbox: placement.isInbox,
      title: parsed.title,
      createdAt: new Date(item.birthtimeMs || item.mtimeMs).toISOString(),
      updatedAt: new Date(item.mtimeMs).toISOString(),
    });
  }

  return [...byId.values()]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, limit);
}

export function loadDshHistory(sessionId, maxMessages = 200) {
  const normalizedId = sessionId.startsWith("session-") ? sessionId : `session-${sessionId}`;
  const files = findAllDshSessionFiles();
  const match = files.find(
    (f) => f.sessionId === sessionId || f.sessionId === normalizedId,
  );
  if (match) {
    const parsed = parseDshZstdFile(match.zstdFile);
    if (parsed && parsed.messages.length > 0) {
      return {
        title: parsed.title,
        updatedAt: new Date(match.mtimeMs).toISOString(),
        messages: parsed.messages.slice(-maxMessages),
      };
    }
  }

  const cacheFile = path.join(
    homeDir,
    ".dsh",
    "storages",
    "session_projcache",
    "sessions",
    `${sessionId}.json`,
  );
  if (fs.existsSync(cacheFile)) {
    try {
      const stat = fs.statSync(cacheFile);
      const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      const rows = parsed?.record?.rows || {};
      const turns = rows.turnOutline?.val?.turns || [];
      const messages = [];
      for (const t of turns) {
        if (t.prompt) messages.push({ id: `dsh-tu-${t.turn}`, role: "user", text: t.prompt });
        if (t.response) {
          messages.push({ id: `dsh-ta-${t.turn}`, role: "assistant", text: t.response });
        }
      }
      return {
        title: truncateTitle(rows.title?.val || sessionId),
        updatedAt: new Date(stat.mtimeMs).toISOString(),
        messages: messages.slice(-maxMessages),
      };
    } catch {
      // ignore
    }
  }

  return { title: null, updatedAt: null, messages: [] };
}

/**
 * 解析指定会话的真实物理工作目录（当会话被归入方式 B 的 `XXX 自由对话` 收件箱时，还原其原始执行目录）
 */
export function resolveRealCwdForSession(provider, sessionId, fallbackCwd = homeDir) {
  const normFallback = ensureExistingDir(fallbackCwd);
  const isInboxDir = normFallback
    .toLowerCase()
    .startsWith(path.join(paseoHome, "inboxes").toLowerCase());
  if (!sessionId) {
    return isInboxDir ? homeDir : normFallback;
  }

  try {
    let list = [];
    if (provider === "codex" || provider === "codex-desktop") {
      list = listCodexSessions({ includeArchived: true });
    } else if (provider === "antigravity") {
      list = listAntigravitySessions();
    } else if (provider === "zcode") {
      list = listZCodeSessions({ includeArchived: true });
    } else if (provider === "dsh") {
      list = listDshSessions({ includeArchived: true });
    }
    const found = list.find((s) => s.sessionId === sessionId);
    if (found?.realCwd) {
      return ensureExistingDir(found.realCwd);
    }
  } catch {
    // ignore
  }

  return isInboxDir ? homeDir : normFallback;
}
