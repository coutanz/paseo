/**
 * Paseo Omni — DSH Desktop (DeepSeek Harness) 进程内 Cordis 原生直连插件
 *
 * 工作原理（对标 CodexBridge DSHDesktopConnector，升级为免配对本机直连）：
 *   1. 作为 Cordis 插件注入 `~/.dsh/profiles/desktop/cordis.patch.yml`，在 DSH 桌面端启动时自动加载；
 *   2. 直接挂载 DSH 桌面端内存中的 `ctx.sessionController` 与 `ctx.workspaceController`；
 *   3. 在 `127.0.0.1:0` 开启受本地 Token 保护的 NDJSON 桥接端口，并将端口描述符写入
 *      `~/.paseo/dsh-desktop-connector.json`；
 *   4. 当 Paseo 发起对话或续接会话时，直接调用 `sessionController.prompt()` 并实时流式转发
 *      `ctx.on("session/event")` 事件，让手机端与 DSH 桌面端窗口 100% 实时同步！
 */

import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const name = "paseo-omni-dsh-desktop-connector";
export const inject = [
  "sessionController",
  "workspaceController",
  "agentDefaultModel",
  "agents",
  "profileContext",
];

function extractTextParts(content) {
  if (!Array.isArray(content)) return { text: "", thinking: "" };
  const textParts = [];
  const thinkingParts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
      textParts.push(item.text);
    } else if (
      (item.type === "reasoning" || item.type === "thinking") &&
      typeof item.text === "string" &&
      item.text.trim()
    ) {
      thinkingParts.push(item.text);
    }
  }
  return {
    text: textParts.join("\n\n"),
    thinking: thinkingParts.join("\n\n"),
  };
}

export function apply(ctx, config = {}) {
  const homeDir = os.homedir();
  const descriptorPath =
    config.descriptorPath || path.join(homeDir, ".paseo", "dsh-desktop-connector.json");
  const token = randomBytes(24).toString("hex");
  const activeStreamWaiters = new Map();

  const disposeEventHook = ctx.on("session/event", (session, event) => {
    const sid = session?.id || event?.sessionId;
    if (!sid) return;
    const waiters = activeStreamWaiters.get(sid);
    if (!waiters || waiters.size === 0) return;

    const eventType = event?.type || "";
    if (eventType === "assistant/message") {
      const msgContent = event?.data?.message?.content || event?.message?.content || [];
      const { text, thinking } = extractTextParts(msgContent);
      for (const w of waiters) {
        if (thinking) {
          w.send({
            type: "stream",
            sessionId: sid,
            kind: "thinking",
            text: thinking,
          });
        }
        if (text) {
          w.emittedAny = true;
          w.send({
            type: "stream",
            sessionId: sid,
            kind: "text",
            text,
          });
        }
      }
    } else if (eventType === "turn/end") {
      for (const w of waiters) {
        w.finish();
      }
    }
  });

  async function ensureDshSession(sessionId, cwd) {
    const controller = new AbortController();
    const listRes = await ctx.sessionController.list({}, controller.signal);
    const sessions = Array.isArray(listRes?.sessions) ? listRes.sessions : [];
    const normalizedTarget = sessionId
      ? sessionId.startsWith("session-")
        ? sessionId
        : `session-${sessionId}`
      : null;

    const found = normalizedTarget
      ? sessions.find((s) => s.id === sessionId || s.id === normalizedTarget)
      : null;
    if (found) {
      return found.id;
    }

    const rootDir = cwd && fs.existsSync(cwd) ? cwd : homeDir;
    const ws = await ctx.workspaceController.create({ path: rootDir });
    const created = await ctx.sessionController.create({
      workspaceId: ws.id,
      ...(normalizedTarget ? { sessionId: normalizedTarget } : {}),
    });
    return created.id;
  }

  async function handleRpc(req, sendLine) {
    const { id, method, params = {} } = req;

    if (method === "ping") {
      sendLine({ id, ok: true, result: { pid: process.pid, name } });
      return;
    }

    if (method === "session/list") {
      const controller = new AbortController();
      const res = await ctx.sessionController.list({}, controller.signal);
      sendLine({ id, ok: true, result: { sessions: res?.sessions || [] } });
      return;
    }

    if (method === "session/cancel") {
      const sid = params.sessionId;
      if (sid) {
        await ctx.sessionController.cancel({ sessionId: sid }).catch(() => {});
        const waiters = activeStreamWaiters.get(sid);
        if (waiters) {
          for (const w of waiters) w.finish("cancelled");
        }
      }
      sendLine({ id, ok: true, result: {} });
      return;
    }

    if (method === "session/prompt") {
      const targetSid = await ensureDshSession(params.sessionId, params.cwd);
      const promptText = String(params.promptText || "").trim() || "Continue.";

      let waiterSet = activeStreamWaiters.get(targetSid);
      if (!waiterSet) {
        waiterSet = new Set();
        activeStreamWaiters.set(targetSid, waiterSet);
      }

      let resolved = false;
      const donePromise = new Promise((resolve) => {
        const waiter = {
          emittedAny: false,
          send(payload) {
            sendLine(payload);
          },
          finish(stopReason = "end_turn") {
            if (resolved) return;
            resolved = true;
            waiterSet.delete(waiter);
            resolve({ stopReason, emittedAny: waiter.emittedAny });
          },
        };
        waiterSet.add(waiter);
        setTimeout(() => waiter.finish("end_turn"), 600_000).unref?.();
      });

      const controller = new AbortController();
      await ctx.sessionController.prompt(
        {
          sessionId: targetSid,
          requestId: randomUUID(),
          mode: "queue",
          content: [{ type: "text", text: promptText }],
        },
        controller.signal,
      );

      const outcome = await donePromise;
      sendLine({
        id,
        ok: true,
        result: {
          sessionId: targetSid,
          stopReason: outcome.stopReason,
          emittedAny: outcome.emittedAny,
        },
      });
      return;
    }

    sendLine({ id, ok: false, error: `Unsupported method: ${method}` });
  }

  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";

    const sendLine = (obj) => {
      if (!socket.destroyed) {
        socket.write(`${JSON.stringify(obj)}\n`);
      }
    };

    socket.on("data", (chunk) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf("\n");
        if (!line) continue;
        try {
          const req = JSON.parse(line);
          if (req.token !== token) {
            sendLine({ id: req.id, ok: false, error: "Unauthorized connector token" });
            continue;
          }
          handleRpc(req, sendLine).catch((err) => {
            sendLine({
              id: req.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        } catch {
          // 忽略格式异常帧
        }
      }
    });
  });

  server.listen(0, "127.0.0.1", () => {
    try {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        fs.mkdirSync(path.dirname(descriptorPath), { recursive: true });
        fs.writeFileSync(
          descriptorPath,
          `${JSON.stringify(
            {
              host: "127.0.0.1",
              port: addr.port,
              token,
              pid: process.pid,
              updatedAt: new Date().toISOString(),
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
      }
    } catch {
      // ignore descriptor write error
    }
  });

  ctx.on("dispose", () => {
    try {
      disposeEventHook?.();
    } catch {
      // ignore
    }
    try {
      server.close();
    } catch {
      // ignore
    }
  });
}

export default {
  name,
  inject,
  apply,
};
