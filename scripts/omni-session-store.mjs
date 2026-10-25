/**
 * Paseo Omni — Local Session Discovery & History Loader for All 4 Agents
 *
 * Reads existing local sessions and full conversation transcripts directly from:
 *   1. OpenAI Codex (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`)
 *   2. Google Antigravity (`~/.gemini/antigravity/brain/<id>` & `~/.gemini/antigravity-cli/<id>`)
 *   3. GLM ZCode (`~/.zcode/cli/db/db.sqlite` via built-in `node:sqlite`)
 *   4. DeepSeek Harness (`~/.dsh/sessions/<ws>/<id>/session.v4.jsonl.zstd` via built-in `zlib.zstdDecompressSync`)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const homeDir = os.homedir();

function ensureExistingDir(candidate) {
  if (candidate && typeof candidate === "string") {
    let resolved = candidate;
    if (resolved.startsWith("file://")) {
      try {
        resolved = fileURLToPath(resolved);
      } catch {
        // ignore invalid file URI
      }
    }
    try {
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        return resolved;
      }
    } catch {
      // fall through
    }
  }
  return homeDir;
}

function cleanUserText(raw) {
  if (!raw || typeof raw !== "string") return "";
  const reqMatch = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i.exec(raw);
  if (reqMatch) {
    return reqMatch[1].trim();
  }
  if (raw.includes("<CONTEXT_SUMMARY>")) {
    return "";
  }
  return raw.trim();
}

function isSyntheticPromptNoise(text) {
  if (!text) return true;
  const t = text.trim();
  return (
    t.startsWith("Available agent types for the Agent tool:") ||
    t.startsWith("<system-reminder>") ||
    t.startsWith("<environment_context>") ||
    t.startsWith("<permissions instructions>") ||
    t.startsWith("# AGENTS.md instructions") ||
    t.startsWith("<turn_aborted>")
  );
}

function truncateTitle(text, maxLen = 60) {
  const cleaned = String(text || "")
    .replace(/^# Files mentioned by the user:[\s\S]*?\n\n/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "未命名会话";
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen)}…` : cleaned;
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
        out.push({ path: full, mtimeMs: stat.mtimeMs });
      } catch {
        // ignore
      }
    }
  }
  return out;
}

// ============================================================================
// 1. OpenAI Codex (`~/.codex/sessions`)
// ============================================================================
export function listCodexSessions({ limit = 20 } = {}) {
  const sessionsRoot = path.join(homeDir, ".codex", "sessions");
  const files = walkJsonlFiles(sessionsRoot).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const results = [];
  const seenIds = new Set();

  for (const file of files) {
    if (results.length >= limit) break;
    try {
      const content = fs.readFileSync(file.path, "utf8");
      const lines = content.split(/\r?\n/);
      let sessionId = null;
      let cwd = homeDir;
      let firstUserPrompt = "";

      for (const line of lines) {
        if (!line.trim()) continue;
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
        } else if (
          !firstUserPrompt &&
          obj.type === "response_item" &&
          obj.payload?.role === "user" &&
          Array.isArray(obj.payload?.content)
        ) {
          const txt = obj.payload.content
            .filter((c) => c && (c.type === "input_text" || c.type === "text") && c.text)
            .map((c) => c.text)
            .filter((t) => !isSyntheticPromptNoise(t))
            .join("\n")
            .trim();
          if (txt) {
            firstUserPrompt = txt;
          }
        }
        if (sessionId && firstUserPrompt) break;
      }

      if (
        !sessionId ||
        seenIds.has(sessionId) ||
        !firstUserPrompt ||
        firstUserPrompt === "Reply with exactly: PASEO-CODEX-OK"
      ) {
        continue;
      }
      seenIds.add(sessionId);
      results.push({
        provider: "codex",
        sessionId,
        cwd,
        title: truncateTitle(firstUserPrompt),
        updatedAt: new Date(file.mtimeMs).toISOString(),
        filePath: file.path,
      });
    } catch {
      // ignore malformed rollout file
    }
  }

  return results;
}

export function loadCodexHistory(sessionId, maxMessages = 80) {
  const sessionsRoot = path.join(homeDir, ".codex", "sessions");
  const files = walkJsonlFiles(sessionsRoot).sort((a, b) => b.mtimeMs - a.mtimeMs);
  const match = files.find((f) => f.path.includes(sessionId));
  if (!match) return { title: null, updatedAt: null, messages: [] };

  const messages = [];
  let firstUserPrompt = "";
  try {
    const lines = fs.readFileSync(match.path, "utf8").split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx];
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      if (obj.type === "event_msg" && obj.payload?.type === "user_message" && obj.payload.message) {
        const text = String(obj.payload.message).trim();
        if (!isSyntheticPromptNoise(text)) {
          if (!firstUserPrompt) firstUserPrompt = text;
          messages.push({ id: `cdx-u-${idx}`, role: "user", text });
        }
      } else if (
        obj.type === "event_msg" &&
        obj.payload?.type === "agent_message" &&
        obj.payload.message
      ) {
        const text = String(obj.payload.message).trim();
        if (text) {
          messages.push({ id: `cdx-a-${idx}`, role: "assistant", text });
        }
      }
    }

    // Fallback to response_item if event_msg had no messages
    if (messages.length === 0) {
      for (let idx = 0; idx < lines.length; idx += 1) {
        const line = lines[idx];
        if (!line.trim()) continue;
        const obj = JSON.parse(line);
        if (obj.type === "response_item" && obj.payload?.type === "message") {
          const role = obj.payload.role;
          if (role !== "user" && role !== "assistant") continue;
          const text = (obj.payload.content || [])
            .filter(
              (c) =>
                c &&
                (c.type === "input_text" || c.type === "output_text" || c.type === "text") &&
                c.text,
            )
            .map((c) => c.text)
            .filter((t) => !isSyntheticPromptNoise(t))
            .join("\n")
            .trim();
          if (text) {
            if (role === "user" && !firstUserPrompt) firstUserPrompt = text;
            messages.push({ id: `cdx-r-${idx}`, role, text });
          }
        }
      }
    }
  } catch {
    // ignore
  }

  return {
    title: firstUserPrompt ? truncateTitle(firstUserPrompt) : sessionId,
    updatedAt: new Date(match.mtimeMs).toISOString(),
    messages: messages.slice(-maxMessages),
  };
}

// ============================================================================
// 2. Google Antigravity (`~/.gemini/antigravity` & `~/.gemini/antigravity-cli`)
// ============================================================================
function findAntigravityTranscriptPath(sessionId) {
  const candidates = [
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

export function listAntigravitySessions({ limit = 20 } = {}) {
  const metaMap = new Map();
  const metaPath = path.join(
    homeDir,
    ".gemini",
    "antigravity-cli",
    "cache",
    "conversation_metadata.json",
  );
  if (fs.existsSync(metaPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      for (const [id, entry] of Object.entries(parsed.conversations || {})) {
        if (entry?.is_internal || entry?.summary?.Internal) continue;
        metaMap.set(id, entry.summary || {});
      }
    } catch {
      // ignore
    }
  }

  const brainRoots = [
    path.join(homeDir, ".gemini", "antigravity", "brain"),
    path.join(homeDir, ".gemini", "antigravity-cli", "brain"),
  ];
  const candidates = [];
  const seen = new Set();

  for (const root of brainRoots) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "tempmediaStorage" || seen.has(entry.name)) {
        continue;
      }
      const transcriptPath = path.join(
        root,
        entry.name,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      if (!fs.existsSync(transcriptPath)) continue;
      seen.add(entry.name);
      const stat = fs.statSync(transcriptPath);
      candidates.push({
        id: entry.name,
        transcriptPath,
        mtimeMs: stat.mtimeMs,
      });
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const results = [];

  for (const item of candidates) {
    if (results.length >= limit) break;
    const summary = metaMap.get(item.id);
    const messages = loadAntigravityHistory(item.id, 6);
    if (messages.length === 0) continue;

    const firstUser = messages.find((m) => m.role === "user");
    const title = summary?.Title || summary?.Preview || firstUser?.text || item.id;
    const wsUri = Array.isArray(summary?.WorkspaceURIs) ? summary.WorkspaceURIs[0] : null;
    const cwd = ensureExistingDir(wsUri);
    const updatedAt = summary?.UpdatedAt
      ? new Date(summary.UpdatedAt).toISOString()
      : new Date(item.mtimeMs).toISOString();

    results.push({
      provider: "antigravity",
      sessionId: item.id,
      cwd,
      title: truncateTitle(title),
      updatedAt,
    });
  }

  return results;
}

export function loadAntigravityHistory(sessionId, maxMessages = 80) {
  const transcriptPath = findAntigravityTranscriptPath(sessionId);
  if (!transcriptPath) return [];
  const messages = [];
  try {
    const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      const step = JSON.parse(line);
      if (step.type === "USER_INPUT" && typeof step.content === "string") {
        const cleaned = cleanUserText(step.content);
        if (cleaned) {
          messages.push({
            id: `agy-u-${step.step_index ?? messages.length}`,
            role: "user",
            text: cleaned,
          });
        }
      } else if (step.type === "PLANNER_RESPONSE") {
        if (typeof step.content === "string" && step.content.trim()) {
          messages.push({
            id: `agy-a-${step.step_index ?? messages.length}`,
            role: "assistant",
            text: step.content.trim(),
            thinking: typeof step.thinking === "string" ? step.thinking.trim() : "",
          });
        }
      }
    }
  } catch {
    // ignore
  }
  return messages.slice(-maxMessages);
}

// ============================================================================
// 3. GLM ZCode (`~/.zcode/cli/db/db.sqlite`)
// ============================================================================
export function listZCodeSessions({ limit = 20 } = {}) {
  const dbPath = path.join(homeDir, ".zcode", "cli", "db", "db.sqlite");
  if (!fs.existsSync(dbPath)) return [];

  let db;
  try {
    db = new DatabaseSync(dbPath, { open: true, readOnly: true });
    const rows = db
      .prepare(
        `SELECT s.id, s.directory, s.title, s.time_updated
         FROM session s
         WHERE s.parent_id IS NULL
           AND s.time_deleted IS NULL
           AND EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id)
         ORDER BY s.time_updated DESC
         LIMIT ?`,
      )
      .all(limit);

    return rows.map((row) => ({
      provider: "zcode",
      sessionId: String(row.id),
      cwd: ensureExistingDir(String(row.directory || homeDir)),
      title: truncateTitle(row.title || row.id),
      updatedAt: new Date(Number(row.time_updated || Date.now())).toISOString(),
    }));
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

export function loadZCodeHistory(sessionId, maxMessages = 80) {
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

    const messages = [];
    for (const m of msgRows) {
      const msgId = String(m.id);
      let role = "assistant";
      try {
        const parsedMsg = JSON.parse(String(m.data));
        if (parsedMsg.role === "user" || parsedMsg.role === "assistant") {
          role = parsedMsg.role;
        } else {
          continue;
        }
      } catch {
        continue;
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

      if (textChunks.length > 0) {
        messages.push({
          id: msgId,
          role,
          text: textChunks.join("\n\n"),
          thinking: thinkingChunks.join("\n\n"),
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
  const dbPath = path.join(homeDir, ".zcode", "cli", "db", "db.sqlite");
  if (!fs.existsSync(dbPath)) return null;
  let db;
  try {
    db = new DatabaseSync(dbPath, { open: true, readOnly: true });
    const row = db.prepare("SELECT title, time_updated FROM session WHERE id = ?").get(sessionId);
    if (!row) return null;
    return {
      title: truncateTitle(row.title || sessionId),
      updatedAt: new Date(Number(row.time_updated || Date.now())).toISOString(),
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

// ============================================================================
// 4. DeepSeek Harness (`~/.dsh/sessions/<ws>/<id>/session.v4.jsonl.zstd`)
// ============================================================================
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
    const messages = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      const evt = JSON.parse(line);
      if (evt.type === "session") {
        sessionId = evt.id || sessionId;
        if (evt.cwd) cwd = ensureExistingDir(evt.cwd);
        parentSession = evt.parentSession || null;
      } else if (evt.type === "session/title" && evt.data?.title) {
        title = evt.data.title;
      } else if (evt.type === "subagent/descriptor" && !title && evt.data?.label) {
        title = evt.data.label;
      } else if (evt.type === "user/message" && Array.isArray(evt.data?.content)) {
        const text = evt.data.content
          .filter((c) => c && c.type === "text" && c.text)
          .map((c) => c.text)
          .join("\n")
          .trim();
        if (text && !isSyntheticPromptNoise(text)) {
          messages.push({
            id: `dsh-u-${evt.seq ?? messages.length}`,
            role: "user",
            text,
          });
        }
      } else if (evt.type === "assistant/message" && Array.isArray(evt.data?.message?.content)) {
        const textParts = [];
        const thinkingParts = [];
        for (const c of evt.data.message.content) {
          if (c?.type === "text" && c.text?.trim()) textParts.push(c.text.trim());
          else if (c?.type === "reasoning" && c.text?.trim()) thinkingParts.push(c.text.trim());
        }
        if (textParts.length > 0) {
          messages.push({
            id: `dsh-a-${evt.seq ?? messages.length}`,
            role: "assistant",
            text: textParts.join("\n\n"),
            thinking: thinkingParts.join("\n\n"),
          });
        }
      }
    }

    return {
      sessionId,
      cwd,
      title: truncateTitle(title || messages[0]?.text || sessionId),
      parentSession,
      messages,
    };
  } catch {
    return null;
  }
}

export function listDshSessions({ limit = 20, includeSubagentsIfEmpty = true } = {}) {
  const files = findAllDshSessionFiles();
  const primary = [];
  const subagents = [];

  for (const item of files) {
    const parsed = parseDshZstdFile(item.zstdFile);
    if (!parsed || parsed.messages.length === 0) continue;
    const entry = {
      provider: "dsh",
      sessionId: parsed.sessionId || item.sessionId,
      cwd: parsed.cwd,
      title: parsed.title,
      updatedAt: new Date(item.mtimeMs).toISOString(),
    };
    if (!parsed.parentSession) {
      primary.push(entry);
    } else {
      subagents.push(entry);
    }
    if (primary.length >= limit) break;
  }

  if (primary.length > 0 || !includeSubagentsIfEmpty) {
    return primary.slice(0, limit);
  }
  return subagents.slice(0, limit);
}

export function loadDshHistory(sessionId, maxMessages = 80) {
  const files = findAllDshSessionFiles();
  const match = files.find(
    (f) => f.sessionId === sessionId || f.sessionId === `session-${sessionId}`,
  );
  if (!match) return { title: null, updatedAt: null, messages: [] };
  const parsed = parseDshZstdFile(match.zstdFile);
  if (!parsed) return { title: null, updatedAt: null, messages: [] };
  return {
    title: parsed.title,
    updatedAt: new Date(match.mtimeMs).toISOString(),
    messages: parsed.messages.slice(-maxMessages),
  };
}
