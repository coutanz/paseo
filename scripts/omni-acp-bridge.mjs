#!/usr/bin/env node

/**
 * Paseo Omni — Universal ACP (Agent Client Protocol) Stdio Bridge
 *
 * Bridges:
 *   - OpenAI Codex Live Mirror (`codex-desktop` for threads locked by Codex Desktop App)
 *   - Google Antigravity CLI (`agy`) + Antigravity Desktop IDE transcripts
 *   - GLM ZCode CLI (`zcode.cjs` / `zcode`) + `~/.zcode/cli/db/db.sqlite` history
 *   - DeepSeek Harness CLI (`dsh.cmd` / `dsh`) + `~/.dsh/sessions` zstd history
 * into standard ACP JSON-RPC 2.0 over NDJSON stdio, including:
 *   - `session/list` (discover existing local sessions)
 *   - `session/load` (replay full historical conversation into Paseo Mobile/Web/Desktop)
 *   - `session/prompt` (continue existing sessions or start new turns)
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import {
  getZCodeSessionTitle,
  isAntigravityCliNativeSession,
  listAntigravitySessions,
  listCodexSessions,
  listDshSessions,
  listZCodeSessions,
  loadAntigravityHistory,
  loadCodexHistory,
  loadDshHistory,
  loadZCodeHistory,
} from "./omni-session-store.mjs";

const isWin = process.platform === "win32";
const homeDir = os.homedir();
const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
const targetProvider = (process.argv[2] || "zcode").toLowerCase();

const PROVIDER_CATALOGS = {
  "codex-desktop": {
    name: "Codex (Desktop Mirror)",
    defaultModel: "gpt-5.4",
    models: [
      { modelId: "gpt-5.4", name: "GPT-5.4 / Configured Default" },
      { modelId: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    ],
    defaultMode: "full-access",
    modes: [
      {
        id: "full-access",
        name: "Full Access (Bypass Sandbox)",
        description: "Runs codex exec with full desktop & Computer Use access",
      },
    ],
  },
  antigravity: {
    name: "Antigravity (Google)",
    defaultModel: "claude-opus-4-6-thinking",
    models: [
      { modelId: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
      { modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { modelId: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
      { modelId: "gemini-3-flash", name: "Gemini 3 Flash" },
    ],
    defaultMode: "yolo",
    modes: [
      { id: "yolo", name: "YOLO (Full Access)", description: "Auto-approve all tool calls and Computer Use" },
      { id: "auto_edit", name: "Auto Edit", description: "Auto-approve file edits" },
      { id: "plan", name: "Plan Mode", description: "Read-only planning mode" },
      { id: "default", name: "Ask Every Time", description: "Prompt before tool execution" },
    ],
  },
  zcode: {
    name: "ZCode (GLM)",
    defaultModel: "glm-5.3",
    models: [
      { modelId: "glm-5.3", name: "GLM 5.3 (Flagship)" },
      { modelId: "glm-5.3-flash", name: "GLM 5.3 Flash" },
      { modelId: "glm-5.1", name: "GLM 5.1" },
      { modelId: "glm-5-turbo", name: "GLM 5 Turbo" },
      { modelId: "glm-4.7", name: "GLM 4.7" },
    ],
    defaultMode: "yolo",
    modes: [
      { id: "yolo", name: "YOLO (Full Access)", description: "Unattended desktop & Computer Use execution" },
      { id: "build", name: "Build Mode", description: "Standard build mode" },
      { id: "edit", name: "Edit Mode", description: "Focused editing mode" },
      { id: "plan", name: "Plan Mode", description: "Read-only planning mode" },
      { id: "guarded", name: "Guarded Mode", description: "Strict permission mode" },
    ],
  },
  dsh: {
    name: "DeepSeek DSH",
    defaultModel: "DeepSeek-V4.1-Flash",
    models: [
      { modelId: "DeepSeek-V4.1-Flash", name: "DeepSeek V4.1 Flash (1M + Vision)" },
      { modelId: "DeepSeek-V4-Flash", name: "DeepSeek V4 Flash" },
      { modelId: "deepseek-chat", name: "DeepSeek Chat" },
      { modelId: "deepseek-reasoner", name: "DeepSeek Reasoner" },
    ],
    defaultMode: "headless",
    modes: [
      { id: "headless", name: "Headless Full Access", description: "Unattended DeepSeek Harness execution" },
    ],
  },
};

const catalog = PROVIDER_CATALOGS[targetProvider] || PROVIDER_CATALOGS.zcode;
const sessions = new Map();

function sendRpc(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sendResult(id, result) {
  sendRpc({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  sendRpc({ jsonrpc: "2.0", id, error: { code, message } });
}

function sendSessionUpdate(sessionId, update) {
  sendRpc({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update,
    },
  });
}

function buildSessionState(session) {
  return {
    models: {
      currentModelId: session.modelId,
      availableModels: catalog.models,
    },
    modes: {
      currentModeId: session.modeId,
      availableModes: catalog.modes,
    },
    configOptions: [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: session.modeId,
        options: catalog.modes.map((m) => ({
          value: m.id,
          name: m.name,
          description: m.description,
        })),
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: session.modelId,
        options: catalog.models.map((m) => ({
          value: m.modelId,
          name: m.name,
        })),
      },
    ],
  };
}

function extractPromptText(promptBlocks) {
  if (!Array.isArray(promptBlocks)) return String(promptBlocks || "");
  const parts = [];
  for (const block of promptBlocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else if (block.type === "resource" && block.resource?.text) {
      parts.push(block.resource.text);
    }
  }
  return parts.join("\n").trim() || "Continue.";
}

function resolveExecutable(provider) {
  const nodeExe = process.execPath;
  if (provider === "codex-desktop") {
    if (isWin) {
      const codexBinRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
      if (existsSync(codexBinRoot)) {
        for (const sub of fs.readdirSync(codexBinRoot)) {
          const candidate = path.join(codexBinRoot, sub, "codex.exe");
          if (existsSync(candidate)) {
            return { command: candidate, baseArgs: [], shell: false };
          }
        }
      }
    }
    return { command: "codex", baseArgs: [], shell: isWin };
  }

  if (provider === "zcode") {
    const zcodeCjs = path.join(localAppData, "Programs", "ZCode", "resources", "glm", "zcode.cjs");
    if (isWin && existsSync(zcodeCjs)) {
      return { command: nodeExe, baseArgs: [zcodeCjs], shell: false };
    }
    return { command: "zcode", baseArgs: [], shell: isWin };
  }

  if (provider === "dsh") {
    const candidates = [
      "E:\\DSH\\resources\\runtime\\cli\\bin\\dsh.cmd",
      "C:\\DSH\\resources\\runtime\\cli\\bin\\dsh.cmd",
      path.join(localAppData, "Programs", "DSH", "resources", "runtime", "cli", "bin", "dsh.cmd"),
    ];
    for (const candidate of candidates) {
      if (isWin && existsSync(candidate)) {
        return { command: candidate, baseArgs: [], shell: true };
      }
    }
    return { command: "dsh", baseArgs: [], shell: isWin };
  }

  if (provider === "antigravity") {
    const agyExe = path.join(localAppData, "agy", "bin", "agy.exe");
    if (isWin && existsSync(agyExe)) {
      return { command: agyExe, baseArgs: [], shell: false };
    }
    return { command: "agy", baseArgs: [], shell: isWin };
  }

  return { command: provider, baseArgs: [], shell: isWin };
}

function killProcessTree(child) {
  if (!child || !child.pid) return;
  if (isWin) {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

function listLocalProviderSessions() {
  if (targetProvider === "codex-desktop") {
    return listCodexSessions({ limit: 50 });
  }
  if (targetProvider === "antigravity") {
    return listAntigravitySessions({ limit: 50 });
  }
  if (targetProvider === "dsh") {
    return listDshSessions({ limit: 50 });
  }
  return listZCodeSessions({ limit: 50 });
}

function replaySessionHistory(session) {
  let messages = [];
  let title = null;
  let updatedAt = null;

  if (targetProvider === "codex-desktop") {
    const loaded = loadCodexHistory(session.id, 80);
    messages = loaded.messages;
    title = loaded.title;
    updatedAt = loaded.updatedAt;
    if (messages.length > 0) {
      session.handoffContext = messages
        .slice(-6)
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text.slice(0, 1200)}`)
        .join("\n\n");
    }
  } else if (targetProvider === "antigravity") {
    messages = loadAntigravityHistory(session.id, 80);
    const meta = listAntigravitySessions({ limit: 60 }).find((s) => s.sessionId === session.id);
    if (meta) {
      title = meta.title;
      updatedAt = meta.updatedAt;
    }
    if (!isAntigravityCliNativeSession(session.id) && messages.length > 0) {
      session.backendSessionId = null;
      session.handoffContext = messages
        .slice(-6)
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text.slice(0, 1200)}`)
        .join("\n\n");
    }
  } else if (targetProvider === "dsh") {
    const loaded = loadDshHistory(session.id, 80);
    messages = loaded.messages;
    title = loaded.title;
    updatedAt = loaded.updatedAt;
  } else {
    messages = loadZCodeHistory(session.id, 80);
    const info = getZCodeSessionTitle(session.id);
    if (info) {
      title = info.title;
      updatedAt = info.updatedAt;
    }
  }

  if (title) {
    sendSessionUpdate(session.id, {
      sessionUpdate: "session_info_update",
      title,
      ...(updatedAt ? { updatedAt } : {}),
    });
  }

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    const msgId = msg.id || `hist-${i}`;
    if (msg.role === "user") {
      sendSessionUpdate(session.id, {
        sessionUpdate: "user_message_chunk",
        messageId: msgId,
        content: { type: "text", text: msg.text },
      });
    } else {
      if (msg.thinking) {
        sendSessionUpdate(session.id, {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: msg.thinking },
        });
      }
      sendSessionUpdate(session.id, {
        sessionUpdate: "agent_message_chunk",
        messageId: msgId,
        content: { type: "text", text: msg.text },
      });
    }
  }
}

async function runCodexMirrorTurn(session, promptText) {
  const { command, baseArgs, shell } = resolveExecutable("codex-desktop");
  let effectivePrompt = promptText;
  const args = [...baseArgs, "exec"];

  if (session.forkedThreadId) {
    args.push(
      "resume",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--json",
      session.forkedThreadId,
      effectivePrompt,
    );
  } else {
    if (session.handoffContext) {
      effectivePrompt = `[以下是此前在 Codex 桌面端会话中的上下文，请无缝衔继续执行]\n${session.handoffContext}\n\n[用户最新指令]\n${promptText}`;
      session.handoffContext = null;
    }
    args.push(
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "--json",
      effectivePrompt,
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: session.cwd,
      env: process.env,
      shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    session.activeChild = child;

    let emittedAny = false;
    let stderr = "";
    const rl = readline.createInterface({ input: child.stdout });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const evt = JSON.parse(trimmed);
        if (evt.thread_id) {
          session.forkedThreadId = evt.thread_id;
        }
        if (evt.type === "item.completed" && evt.item?.type === "agent_message" && evt.item.text) {
          emittedAny = true;
          sendSessionUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: evt.item.text },
          });
        } else if (evt.type === "item.completed" && evt.item?.type === "reasoning" && evt.item.text) {
          sendSessionUpdate(session.id, {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: evt.item.text },
          });
        }
      } catch {
        // ignore non-json lines
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });

    child.on("error", (err) => {
      session.activeChild = null;
      reject(err);
    });

    child.on("close", (code) => {
      session.activeChild = null;
      if (session.canceled) {
        resolve({ stopReason: "cancelled" });
        return;
      }
      if (code !== 0 && !emittedAny) {
        sendSessionUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: stderr.trim() || `Codex exited with code ${code}`,
          },
        });
      }
      resolve({ stopReason: "end_turn" });
    });
  });
}

async function runAntigravityTurn(session, promptText) {
  const { command, baseArgs, shell } = resolveExecutable("antigravity");
  const args = [
    ...baseArgs,
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--approval-mode",
    session.modeId || "yolo",
  ];
  if (session.modelId) {
    args.push("--model", session.modelId);
  }
  if (session.backendSessionId) {
    args.push("--resume", session.backendSessionId);
  }

  let effectivePrompt = promptText;
  if (!session.backendSessionId && session.handoffContext) {
    effectivePrompt = `[以下是此前在 Antigravity 桌面端会话中的最近上下文，请无缝衔继续回答]\n${session.handoffContext}\n\n[用户最新指令]\n${promptText}`;
    session.handoffContext = null;
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: session.cwd,
      env: process.env,
      shell,
      stdio: ["pipe", "pipe", "pipe"],
    });
    session.activeChild = child;

    const userPayload = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: effectivePrompt }],
      },
    });
    child.stdin.write(`${userPayload}\n`);
    child.stdin.end();

    let emittedAny = false;
    let stderr = "";
    const rl = readline.createInterface({ input: child.stdout });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const evt = JSON.parse(trimmed);
        if (evt.session_id) {
          session.backendSessionId = evt.session_id;
        }
        if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
          for (const part of evt.message.content) {
            if (part.type === "thinking" && part.thinking) {
              sendSessionUpdate(session.id, {
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text: part.thinking },
              });
            } else if (part.type === "text" && part.text) {
              emittedAny = true;
              sendSessionUpdate(session.id, {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: part.text },
              });
            }
          }
        } else if (evt.type === "result" && typeof evt.result === "string" && !emittedAny) {
          emittedAny = true;
          sendSessionUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: evt.result },
          });
        }
      } catch {
        emittedAny = true;
        sendSessionUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `${trimmed}\n` },
        });
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });

    child.on("error", (err) => {
      session.activeChild = null;
      reject(err);
    });

    child.on("close", (code) => {
      session.activeChild = null;
      if (session.canceled) {
        resolve({ stopReason: "cancelled" });
        return;
      }
      if (code !== 0 && !emittedAny) {
        sendSessionUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: stderr.trim() || `Antigravity exited with code ${code}`,
          },
        });
      }
      resolve({ stopReason: "end_turn" });
    });
  });
}

async function runZCodeTurn(session, promptText) {
  const { command, baseArgs, shell } = resolveExecutable("zcode");
  const args = [
    ...baseArgs,
    "-p",
    promptText,
    "--json",
    "--surface",
    "desktop",
    "--cwd",
    session.cwd,
    "--mode",
    session.modeId || "yolo",
  ];
  if (session.backendSessionId) {
    args.push("--resume", session.backendSessionId);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: session.cwd,
      env: process.env,
      shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    session.activeChild = child;

    let emittedAny = false;
    let stderr = "";
    const rl = readline.createInterface({ input: child.stdout });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.session_id || obj.sessionId) {
          session.backendSessionId = obj.session_id || obj.sessionId;
        }
        const text = obj.response ?? obj.text ?? obj.content ?? obj.result;
        if (typeof text === "string" && text) {
          emittedAny = true;
          sendSessionUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          });
        }
      } catch {
        emittedAny = true;
        sendSessionUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `${trimmed}\n` },
        });
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });

    child.on("error", (err) => {
      session.activeChild = null;
      reject(err);
    });

    child.on("close", (code) => {
      session.activeChild = null;
      if (session.canceled) {
        resolve({ stopReason: "cancelled" });
        return;
      }
      if (code !== 0 && !emittedAny) {
        sendSessionUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: stderr.trim() || `ZCode exited with code ${code}`,
          },
        });
      }
      resolve({ stopReason: "end_turn" });
    });
  });
}

async function runDshTurn(session, promptText) {
  const { command, baseArgs, shell } = resolveExecutable("dsh");
  const args = [...baseArgs, "--profile", "headless", "--json"];
  if (session.backendSessionId) {
    args.push("--session-id", session.backendSessionId);
  }
  args.push(promptText);

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: session.cwd,
      env: process.env,
      shell,
      stdio: ["ignore", "pipe", "pipe"],
    });
    session.activeChild = child;

    let emittedAny = false;
    let stderr = "";
    const rl = readline.createInterface({ input: child.stdout });

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const obj = JSON.parse(trimmed);
        if (obj.sessionId || obj.session_id) {
          session.backendSessionId = obj.sessionId || obj.session_id;
        }
        const text = obj.text ?? obj.content ?? obj.message ?? obj.result;
        if (typeof text === "string" && text) {
          emittedAny = true;
          sendSessionUpdate(session.id, {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          });
        }
      } catch {
        emittedAny = true;
        sendSessionUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `${trimmed}\n` },
        });
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8192);
    });

    child.on("error", (err) => {
      session.activeChild = null;
      reject(err);
    });

    child.on("close", (code) => {
      session.activeChild = null;
      if (session.canceled) {
        resolve({ stopReason: "cancelled" });
        return;
      }
      if (code !== 0 && !emittedAny) {
        sendSessionUpdate(session.id, {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: stderr.trim() || `DSH exited with code ${code}`,
          },
        });
      }
      resolve({ stopReason: "end_turn" });
    });
  });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize":
      sendResult(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: {
            list: {},
            close: {},
          },
          promptCapabilities: {
            image: true,
            embeddedContext: true,
          },
        },
        agentInfo: {
          name: catalog.name,
          version: "1.2.0",
        },
      });
      return;

    case "authenticate":
      sendResult(id, {});
      return;

    case "session/list": {
      const all = listLocalProviderSessions();
      const filtered = params?.cwd
        ? all.filter(
            (s) => path.resolve(s.cwd).toLowerCase() === path.resolve(params.cwd).toLowerCase(),
          )
        : all;
      sendResult(id, {
        sessions: filtered.map((s) => ({
          sessionId: s.sessionId,
          cwd: s.cwd,
          title: s.title,
          updatedAt: s.updatedAt,
        })),
        nextCursor: null,
      });
      return;
    }

    case "session/new": {
      const sessionId = randomUUID();
      const session = {
        id: sessionId,
        cwd: params?.cwd || process.cwd(),
        modelId: catalog.defaultModel,
        modeId: catalog.defaultMode,
        backendSessionId: null,
        forkedThreadId: null,
        handoffContext: null,
        activeChild: null,
        canceled: false,
      };
      sessions.set(sessionId, session);
      sendResult(id, {
        sessionId,
        ...buildSessionState(session),
      });
      return;
    }

    case "session/load":
    case "session/resume": {
      const sessionId = params?.sessionId || randomUUID();
      let session = sessions.get(sessionId);
      if (!session) {
        session = {
          id: sessionId,
          cwd: params?.cwd || process.cwd(),
          modelId: catalog.defaultModel,
          modeId: catalog.defaultMode,
          backendSessionId: sessionId,
          forkedThreadId: null,
          handoffContext: null,
          activeChild: null,
          canceled: false,
        };
        sessions.set(sessionId, session);
      }
      if (method === "session/load") {
        replaySessionHistory(session);
      }
      sendResult(id, {
        sessionId,
        ...buildSessionState(session),
      });
      return;
    }

    case "session/set_mode": {
      const session = sessions.get(params?.sessionId);
      if (session && params?.modeId) {
        session.modeId = params.modeId;
      }
      sendResult(id, {});
      return;
    }

    case "session/set_model": {
      const session = sessions.get(params?.sessionId);
      if (session && params?.modelId) {
        session.modelId = params.modelId;
      }
      sendResult(id, {});
      return;
    }

    case "session/set_config_option": {
      const session = sessions.get(params?.sessionId);
      if (session) {
        if (params?.configId === "mode" && params?.value) {
          session.modeId = String(params.value);
        } else if (params?.configId === "model" && params?.value) {
          session.modelId = String(params.value);
        }
        sendResult(id, {
          configOptions: buildSessionState(session).configOptions,
        });
      } else {
        sendResult(id, { configOptions: [] });
      }
      return;
    }

    case "session/prompt": {
      const sessionId = params?.sessionId;
      let session = sessions.get(sessionId);
      if (!session) {
        session = {
          id: sessionId || randomUUID(),
          cwd: process.cwd(),
          modelId: catalog.defaultModel,
          modeId: catalog.defaultMode,
          backendSessionId: sessionId || null,
          forkedThreadId: null,
          handoffContext: null,
          activeChild: null,
          canceled: false,
        };
        sessions.set(session.id, session);
      }
      session.canceled = false;
      const promptText = extractPromptText(params?.prompt);

      let result;
      if (targetProvider === "codex-desktop") {
        result = await runCodexMirrorTurn(session, promptText);
      } else if (targetProvider === "antigravity") {
        result = await runAntigravityTurn(session, promptText);
      } else if (targetProvider === "dsh") {
        result = await runDshTurn(session, promptText);
      } else {
        result = await runZCodeTurn(session, promptText);
      }
      sendResult(id, result);
      return;
    }

    case "session/cancel": {
      const session = sessions.get(params?.sessionId);
      if (session?.activeChild) {
        session.canceled = true;
        killProcessTree(session.activeChild);
      }
      if (id !== undefined) sendResult(id, {});
      return;
    }

    case "session/close": {
      const session = sessions.get(params?.sessionId);
      if (session?.activeChild) {
        session.canceled = true;
        killProcessTree(session.activeChild);
      }
      sessions.delete(params?.sessionId);
      if (id !== undefined) sendResult(id, {});
      return;
    }

    default:
      if (id !== undefined) {
        sendResult(id, {});
      }
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    handleRequest(msg).catch((err) => {
      if (msg.id !== undefined) {
        sendError(msg.id, -32603, err instanceof Error ? err.message : String(err));
      }
    });
  } catch {
    // Ignore malformed input lines
  }
});
