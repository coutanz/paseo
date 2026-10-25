/**
 * Paseo Omni — 四大桌面 Agent 官方索引源发现、无损历史提取与本地双向同步核心模块
 *
 * 数据源与清洗策略：
 *   1. OpenAI Codex：读取 `~/.codex/state_5.sqlite` (`threads` 表) + `~/.codex/session_index.jsonl`，
 *      排除归档会话与子代理 (`agent_role IS NULL`)，剥离剪贴板贴图临时路径前缀并还原真实中文标题。
 *   2. Google Antigravity：读取 `~/.gemini/antigravity/conversation_summaries.db` 与
 *      `~/.gemini/antigravity-cli/conversation_summaries.db` (`parent_conversation_id = ''`)，
 *      改读未截断的 `transcript_full.jsonl`（仅保留 `USER_EXPLICIT` 输入与每轮最终答复），
 *      并提供本机 `language_server` ConnectRPC 动态发现与双向通信辅助函数。
 *   3. GLM ZCode：关联 `~/.zcode/v2/tasks-index.sqlite`（过滤桌面端已删除/已归档任务）与
 *      `~/.zcode/cli/db/db.sqlite`（按 `semantics.origin === "real_user"` 与 `finish === "stop"` 提纯对话），
 *      支持在 Paseo 对话后双向回写 `tasks-index.sqlite`。
 *   4. DeepSeek Harness (DSH)：读取 `~/.dsh/storages/workspace.json` + `session_projcache/sessions/*.json`
 *      （过滤已归档会话、空会话与子代理），从 `session.v4.jsonl.zstd` 按 `source.kind === "user"` 无损提取问答轮次。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const isWin = process.platform === "win32";
const homeDir = os.homedir();

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

export function cleanCodexPromptText(raw) {
  if (!raw || typeof raw !== "string") return "";
  let text = raw.trim();

  const hasClipboardImg = /codex-clipboard-[^\s:]+\.png/i.test(text) || /Image attachment:\s*true/i.test(text);
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
    // 没有 `## My request:` 时，剔除临时路径头保留真实正文
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
  // 将 `[https://xxx](https://xxx)` 简化为可读链接文本
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
               cwd, title, first_user_message, name, model, archived, agent_role
        FROM threads
        WHERE (agent_role IS NULL OR agent_role = '')
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

        const cwd = ensureExistingDir(row.cwd);
        const createdAt = normalizeIsoTimestamp(row.created_at_ms ?? row.created_at);
        const updatedAt = normalizeIsoTimestamp(row.updated_at_ms ?? row.updated_at);
        const rolloutPath = stripWinExtendedPrefix(String(row.rollout_path || ""));

        results.push({
          provider: "codex",
          sessionId: id,
          cwd,
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

  // 回退方案：扫描 `~/.codex/sessions`，排除带 `_subagentId` 的子代理文件
  const sessionsRoot = path.join(homeDir, ".codex", "sessions");
  const files = walkJsonlFiles(sessionsRoot)
    .filter((f) => !/_[0-9a-f-]{20,}\.jsonl$/i.test(f.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const results = [];
  const seenIds = new Set();

  for (const file of files) {
    if (results.length >= limit) break;
    try {
      const lines = readTailLines(file.path, 512 * 1024);
      let sessionId = null;
      let cwd = homeDir;
      let firstUserPrompt = "";

      const headLines = fs.readFileSync(file.path, "utf8").slice(0, 65536).split(/\r?\n/);
      for (const line of [...headLines, ...lines.slice(0, 30)]) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === "session_meta" && obj.payload) {
            sessionId = obj.payload.id || obj.payload.session_id || sessionId;
            if (obj.payload.cwd) cwd = ensureExistingDir(obj.payload.cwd);
          } else if (
            !firstUserPrompt &&
            obj.type === "event_msg" &&
            obj.payload?.type === "user_message" &&
            typeof obj.payload?.message === "string" &&
            !isSyntheticPromptNoise(obj.payload.message)
          ) {
            firstUserPrompt = obj.payload.message;
          }
          if (sessionId && firstUserPrompt) break;
        } catch {
          // ignore
        }
      }

      if (!sessionId || seenIds.has(sessionId) || !firstUserPrompt) continue;
      seenIds.add(sessionId);
      const indexedTitle = titleIndex.get(sessionId);
      results.push({
        provider: "codex",
        sessionId,
        cwd,
        title: indexedTitle ? truncateTitle(indexedTitle) : cleanCodexTitle(firstUserPrompt),
        createdAt: new Date(file.birthtimeMs || file.mtimeMs).toISOString(),
        updatedAt: new Date(file.mtimeMs).toISOString(),
        model: null,
        filePath: file.path,
      });
    } catch {
      // ignore
    }
  }

  return results;
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
      // 优先连接桌面版主实例 (`--app_data_dir antigravity`)
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
          // 尝试下一个监听端口（例如跳过 HTTPS 端口命中 HTTP 端口）
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

  // 1. 优先从桌面端与 CLI 的官方 SQLite 摘要库读取根会话（天然剔除所有 Subagent 子代理）
  for (const sub of ["antigravity", "antigravity-cli"]) {
    const dbPath = path.join(homeDir, ".gemini", sub, "conversation_summaries.db");
    if (!fs.existsSync(dbPath)) continue;
    let db;
    try {
      db = new DatabaseSync(dbPath, { open: true, readOnly: true });
      const rows = db
        .prepare(
          `SELECT conversation_id, title, preview, step_count, last_modified_time,
                  last_user_input_time, workspace_uris, parent_conversation_id,
                  nesting_depth, killed, app_data_dir
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
        const updatedAt = normalizeIsoTimestamp(r.last_modified_time || r.last_user_input_time);
        const existing = byId.get(id);
        if (existing && Date.parse(existing.updatedAt) >= Date.parse(updatedAt)) {
          continue;
        }
        const rawTitle = String(r.title || r.preview || id).trim();
        const cwd = ensureExistingDir(r.workspace_uris ? String(r.workspace_uris) : "");
        byId.set(id, {
          provider: "antigravity",
          sessionId: id,
          cwd,
          title: truncateTitle(cleanAntigravityUserText(rawTitle) || rawTitle),
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

  // 2. 补充扫描 brain 目录，严格要求存在 `source === "USER_EXPLICIT"` 才放行（杜绝子代理混入）
  for (const sub of ["antigravity", "antigravity-cli"]) {
    const root = path.join(homeDir, ".gemini", sub, "brain");
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "tempmediaStorage" || byId.has(entry.name)) {
        continue;
      }
      const transcriptPath = findAntigravityTranscriptPath(entry.name);
      if (!transcriptPath) continue;
      try {
        const stat = fs.statSync(transcriptPath);
        const head = fs.readFileSync(transcriptPath, "utf8").slice(0, 128 * 1024).split(/\r?\n/);
        let firstExplicitText = "";
        for (const line of head) {
          if (!line.trim()) continue;
          try {
            const step = JSON.parse(line);
            if (step.type === "USER_INPUT" && step.source === "USER_EXPLICIT") {
              firstExplicitText = cleanAntigravityUserText(step.content);
              if (firstExplicitText) break;
            }
          } catch {
            // ignore
          }
        }
        if (!firstExplicitText) continue;
        byId.set(entry.name, {
          provider: "antigravity",
          sessionId: entry.name,
          cwd: homeDir,
          title: truncateTitle(firstExplicitText),
          createdAt: new Date(stat.birthtimeMs || stat.mtimeMs).toISOString(),
          updatedAt: new Date(stat.mtimeMs).toISOString(),
        });
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
        // 严格只保留真实用户输入，剔除系统恢复提示与子代理消息
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
    const validSessionIds = new Set(
      cliDb
        .prepare(
          `SELECT s.id
           FROM session s
           WHERE s.parent_id IS NULL
             AND s.time_deleted IS NULL
             AND EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id)`,
        )
        .all()
        .map((r) => String(r.id)),
    );

    if (fs.existsSync(tasksDbPath)) {
      tasksDb = new DatabaseSync(tasksDbPath, { open: true, readOnly: true });
      const taskRows = tasksDb
        .prepare(
          `SELECT task_id, title, cli_title, workspace_path, root_path, created_at, updated_at
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
        if (!id || !validSessionIds.has(id)) continue;
        const rawTitle = String(row.title || row.cli_title || id).trim();
        const cwd = ensureExistingDir(String(row.workspace_path || row.root_path || homeDir));
        results.push({
          provider: "zcode",
          sessionId: id,
          cwd,
          title: truncateTitle(rawTitle),
          createdAt: normalizeIsoTimestamp(row.created_at || row.updated_at),
          updatedAt: normalizeIsoTimestamp(row.updated_at),
        });
      }
      return results;
    }

    // 无桌面端 v2 库时回退到纯 CLI 库
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

    return rows.slice(0, limit).map((row) => ({
      provider: "zcode",
      sessionId: String(row.id),
      cwd: ensureExistingDir(String(row.directory || homeDir)),
      title: truncateTitle(row.title || row.id),
      createdAt: normalizeIsoTimestamp(row.time_created || row.time_updated),
      updatedAt: normalizeIsoTimestamp(row.time_updated),
    }));
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

      // 过滤系统自动注入的隐藏提醒消息 (`system_reminder` / `todo_reminder`)
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
    // 若 ZCode 桌面端正短暂锁表则安全跳过，不影响主会话返回
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

// ============================================================================
// 4. DeepSeek Harness (`workspace.json` + `session_projcache` + `session.v4.jsonl.zstd`)
// ============================================================================
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
        // 严格只保留真实用户发送的消息 (`source.kind === "user"`)
        const sourceKind = evt.data?.source?.kind;
        if (sourceKind && sourceKind !== "user") continue;

        const text = evt.data.content
          .filter((c) => c && c.type === "text" && c.text)
          .map((c) => c.text)
          .join("\n")
          .trim();
        if (!text || isSyntheticPromptNoise(text)) continue;

        // 若无显式 `source` 字段但属于系统注入，已被 `isSyntheticPromptNoise` 拦截
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

        const titleVal =
          rows.title?.val ||
          rows.titleInput?.val?.first?.text ||
          turns[0]?.prompt ||
          rawId;
        const cwd = ensureExistingDir(rows.workingDirectory?.val || identity.cwd);
        const updatedMs =
          rows.timeContext?.val?.lastMessageTime ||
          rows.sessionListMetadata?.val?.lastPromptAt ||
          stat.mtimeMs;
        const createdMs = identity.createdAt || stat.birthtimeMs || updatedMs;

        byId.set(rawId, {
          provider: "dsh",
          sessionId: rawId,
          cwd,
          title: truncateTitle(titleVal),
          createdAt: normalizeIsoTimestamp(createdMs),
          updatedAt: normalizeIsoTimestamp(updatedMs),
        });
      } catch {
        // ignore
      }
    }
  }

  // 2. 补充扫描 `.jsonl.zstd`（兼容纯 CLI 新建且尚未写入桌面缓存的会话）
  for (const item of findAllDshSessionFiles()) {
    if (byId.has(item.sessionId)) continue;
    if (!includeArchived && archivedSet.has(item.sessionId)) continue;
    const parsed = parseDshZstdFile(item.zstdFile);
    if (!parsed || parsed.isSubagent || parsed.messages.length === 0) continue;
    const sid = parsed.sessionId || item.sessionId;
    if (!includeArchived && archivedSet.has(sid)) continue;
    if (byId.has(sid)) continue;

    byId.set(sid, {
      provider: "dsh",
      sessionId: sid,
      cwd: parsed.cwd,
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

  // 回退读取投影缓存大纲
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
