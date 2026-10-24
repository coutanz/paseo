import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execCommand, spawnProcess } from "@getpaseo/plugin/server";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCatalog,
  type ProviderConfigChanges,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderLaunch,
  type ProviderMode,
  type ProviderModel,
  type ProviderPersistence,
  type ProviderPrompt,
  type ProviderRegistration,
  type ProviderSessionConfig,
} from "@getpaseo/plugin/server/provider";
import { z } from "zod";

const capabilities = [
  "prompt.message",
  "prompt.image",
  "session.configure",
  "session.persistence",
] as const;

const ZCODE_MODELS: readonly ProviderModel[] = [
  { id: "glm-5.3", label: "GLM 5.3 (Flagship)" },
  { id: "glm-5.3-flash", label: "GLM 5.3 Flash" },
  { id: "glm-5.1", label: "GLM 5.1" },
  { id: "glm-5-turbo", label: "GLM 5 Turbo" },
  { id: "glm-4.7", label: "GLM 4.7" },
  { id: "glm-4.5-air", label: "GLM 4.5 Air" },
];

// Matches real `zcode 0.17.0 --help` modes: build, edit, plan, yolo, or guarded
const ZCODE_MODES: readonly ProviderMode[] = [
  {
    id: "yolo",
    icon: "ShieldOff",
    colorTier: "dangerous",
    label: "YOLO (Full Access)",
    description:
      "Runs ZCode in unattended `--mode yolo --surface desktop` so shell commands, edits, and Windows Computer Use execute without prompts.",
    isUnattended: true,
  },
  {
    id: "build",
    icon: "ShieldCheck",
    colorTier: "moderate",
    label: "Build Mode",
    description: "Standard ZCode build mode with tool execution.",
  },
  {
    id: "edit",
    icon: "ShieldPlus",
    colorTier: "moderate",
    label: "Edit Mode",
    description: "Focused file editing mode.",
  },
  {
    id: "plan",
    icon: "ShieldEllipsis",
    colorTier: "planning",
    label: "Plan Mode",
    description: "Read-only planning and architecture analysis mode.",
  },
  {
    id: "guarded",
    icon: "Shield",
    colorTier: "safe",
    label: "Guarded Mode",
    description: "Strict permission mode for sensitive environments.",
  },
];

const ZCODE_CATALOG: ProviderCatalog = {
  models: ZCODE_MODELS,
  modes: ZCODE_MODES,
  thinkingOptions: [],
  defaultMode: "yolo",
};

const persistenceSchema = z
  .object({
    version: z.literal(1),
    data: z.object({ sessionId: z.string().min(1) }).strict(),
  })
  .strict();

class ZCodeError extends Error {
  constructor(
    message: string,
    readonly code = "ZCODE_ERROR",
  ) {
    super(message);
    this.name = "ZCodeError";
  }
}

function resolveDefaultZCodeCommand(): readonly string[] {
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const bundledCjs = path.join(
      localAppData,
      "Programs",
      "ZCode",
      "resources",
      "glm",
      "zcode.cjs",
    );
    if (existsSync(bundledCjs)) {
      return ["node", bundledCjs];
    }
  }
  return ["zcode"];
}

export function createZCodeProvider(): ProviderRegistration {
  return {
    id: "zcode",
    label: "ZCode (GLM)",
    icon: "icon.svg",
    command: resolveDefaultZCodeCommand(),
    description:
      "Z.AI official ZCode CLI / desktop harness for GLM-5.3 with native MCP and Windows Computer Use support",
    async status({ launch }) {
      if (!launch) {
        return {
          available: false,
          diagnostic:
            "zcode not found on PATH. Run `npm run omni:sync-mcp` to auto-bind `%LOCALAPPDATA%\\Programs\\ZCode\\resources\\glm\\zcode.cjs`.",
        };
      }
      return { available: true };
    },
    async getCatalogCacheKey({ launch }) {
      if (!launch) return undefined;
      const env = Object.entries(launch.env).sort(([left], [right]) => left.localeCompare(right));
      return createHash("sha256")
        .update(JSON.stringify([launch.command, launch.args, env]))
        .digest("hex");
    },
    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new ZCodeError("Provider protocol version 1 is required");
      }
      if (!request.launch) {
        throw new ZCodeError("The daemon must supply the ZCode launch");
      }
      const negotiated = negotiateProviderCapabilities(request.capabilities, capabilities);
      return createZCodeConnection(request.launch, negotiated);
    },
  };
}

function createZCodeConnection(
  launch: ProviderLaunch,
  negotiated: readonly string[],
): ProviderConnection {
  const sessions = new Map<string, ZCodeSession>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  let closed = false;
  let pending = Promise.resolve();

  function emit(event: ProviderEvent): void {
    if (closed) return;
    for (const listener of listeners) listener(event);
  }

  function getSession(id: string): ZCodeSession {
    const found = sessions.get(id);
    if (!found) throw new ZCodeError(`Unknown ZCode session: ${id}`);
    return found;
  }

  async function dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: ZCODE_CATALOG,
        });
        return;
      case "session.open": {
        if (sessions.has(input.sessionId)) {
          throw new ZCodeError(`Session already exists: ${input.sessionId}`);
        }
        const opened = new ZCodeSession({
          id: input.sessionId,
          config: input.config,
          persistence: input.persistence,
          launch,
          emit,
        });
        sessions.set(input.sessionId, opened);
        opened.open(input.requestId, negotiated);
        return;
      }
      case "session.prompt":
        await getSession(input.sessionId).prompt(input.prompt);
        return;
      case "session.configure":
        getSession(input.sessionId).configure(input.changes);
        break;
      case "session.interrupt":
        await getSession(input.sessionId).interrupt();
        break;
      case "session.close": {
        await getSession(input.sessionId).close();
        sessions.delete(input.sessionId);
        emit({ type: "session.closed", sessionId: input.sessionId });
        break;
      }
      default:
        throw new ZCodeError(`Unsupported ZCode operation: ${input.type}`);
    }
    emit({ type: "request.completed", requestId: input.requestId });
  }

  function failed(input: ProviderInput, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof ZCodeError ? error.code : "ZCODE_ERROR";
    if (input.type === "session.prompt") {
      emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { message, code } },
      });
    } else if ("requestId" in input) {
      emit({ type: "request.failed", requestId: input.requestId, error: { message, code } });
    }
  }

  return {
    version: 1,
    capabilities: negotiated,
    async send(input) {
      if (closed) throw new ZCodeError("ZCode connection is closed");
      requireProviderCapabilities(negotiated, input);
      pending = pending
        .then(async () => {
          if (!closed) await dispatch(input);
          return undefined;
        })
        .catch((error) => failed(input, error));
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      await pending;
      await Promise.all([...sessions.values()].map((opened) => opened.close()));
      sessions.clear();
      listeners.clear();
    },
  };
}

interface ZCodeSessionOptions {
  id: string;
  config: ProviderSessionConfig;
  launch: ProviderLaunch;
  persistence?: ProviderPersistence;
  emit(event: ProviderEvent): void;
}

class ZCodeSession {
  private config: ProviderSessionConfig;
  private zcodeSessionId: string | null;
  private firstMessage: boolean;
  private activeChild: ChildProcessWithoutNullStreams | null = null;
  private interrupted = false;
  private attachmentDir: string | null = null;

  constructor(private readonly options: ZCodeSessionOptions) {
    this.config = {
      ...options.config,
      model: options.config.model ?? "glm-5.3",
      mode: options.config.mode ?? "yolo",
    };
    this.zcodeSessionId = options.persistence
      ? persistenceSchema.parse(options.persistence).data.sessionId
      : null;
    this.firstMessage = this.zcodeSessionId === null;
  }

  open(requestId: string, negotiatedCapabilities: readonly string[]): void {
    this.options.emit({
      type: "session.opened",
      requestId,
      sessionId: this.options.id,
      capabilities: negotiatedCapabilities,
      restoration: "core",
      persistence:
        this.config.persist && this.zcodeSessionId ? this.persistence() : undefined,
      cwd: this.config.cwd,
      title: this.config.title,
    });
    this.publishConfig();
    this.options.emit({ type: "session.commands", sessionId: this.options.id, commands: [] });
    this.options.emit({ type: "session.ready", requestId, sessionId: this.options.id });
  }

  configure(changes: ProviderConfigChanges): void {
    this.config = {
      ...this.config,
      model: changes.model === null ? undefined : (changes.model ?? this.config.model),
      mode: changes.mode === null ? "yolo" : (changes.mode ?? this.config.mode),
    };
    this.publishConfig();
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (this.activeChild !== null) {
      throw new ZCodeError("ZCode already has an active turn; wait for it to finish", "TURN_ACTIVE");
    }
    if (prompt.input.type !== "message" || prompt.delivery === "steer") {
      throw new ZCodeError("ZCode supports standard message prompts only");
    }

    const { displayText, promptText, attachedFiles } = await this.encodePrompt(prompt);
    const turnId = randomUUID();
    this.interrupted = false;

    this.options.emit({
      type: "session.prompt_result",
      sessionId: this.options.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId },
    });
    this.options.emit({
      type: "session.turn",
      sessionId: this.options.id,
      turnId,
      state: "started",
    });
    this.options.emit({
      type: "timeline.item",
      sessionId: this.options.id,
      item: {
        type: "user_message",
        id: prompt.clientMessageId,
        clientMessageId: prompt.clientMessageId,
        text: displayText,
      },
    });

    const fullPrompt =
      this.firstMessage && this.config.systemPrompt
        ? `${this.config.systemPrompt}\n\n${promptText}`
        : promptText;

    // Matches `zcode 0.17.0` real CLI flags: -p <text> --json --cwd <path> --mode <mode> --surface desktop
    const args = [
      ...this.options.launch.args,
      "-p",
      fullPrompt,
      "--json",
      "--surface",
      "desktop",
      "--cwd",
      this.config.cwd,
      "--mode",
      this.config.mode || "yolo",
    ];
    if (!this.firstMessage && this.zcodeSessionId) {
      args.push("--resume", this.zcodeSessionId);
    }
    for (const file of attachedFiles) {
      args.push("--attach", file);
    }

    await new Promise<void>((resolve) => {
      const child = spawnProcess(this.options.launch.command, args, {
        cwd: this.config.cwd,
        env: { ...this.options.launch.env, ...this.config.env },
        detached: process.platform !== "win32",
        stdio: "pipe",
      });
      this.activeChild = child;

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8192);
      });
      child.on("error", (error: Error) => {
        this.activeChild = null;
        this.options.emit({
          type: "session.turn",
          sessionId: this.options.id,
          turnId,
          state: "failed",
          error: { message: error.message, code: "SPAWN_ERROR" },
        });
        resolve();
      });
      child.on("close", (code) => {
        this.activeChild = null;
        if (this.interrupted) {
          this.options.emit({
            type: "session.turn",
            sessionId: this.options.id,
            turnId,
            state: "canceled",
          });
          resolve();
          return;
        }
        if (code !== 0 && !stdout.trim()) {
          this.options.emit({
            type: "session.turn",
            sessionId: this.options.id,
            turnId,
            state: "failed",
            error: {
              message: stderr.trim() || `ZCode exited with code ${code}`,
              code: "PROCESS_EXIT",
            },
          });
          resolve();
          return;
        }

        const parsed = parseZCodeOutput(stdout);
        if (parsed.sessionId) {
          this.zcodeSessionId = parsed.sessionId;
          if (this.config.persist) {
            this.options.emit({
              type: "session.persistence",
              sessionId: this.options.id,
              persistence: this.persistence(),
            });
          }
        }
        this.firstMessage = false;

        const messageId = `${turnId}:response`;
        this.options.emit({
          type: "timeline.item",
          sessionId: this.options.id,
          item: {
            type: "assistant_message",
            id: messageId,
            messageId,
            text: parsed.text || stdout.trim() || "(completed)",
          },
        });

        if (parsed.usage) {
          this.options.emit({
            type: "session.usage",
            sessionId: this.options.id,
            turnId,
            usage: parsed.usage,
          });
        }

        this.options.emit({
          type: "session.turn",
          sessionId: this.options.id,
          turnId,
          state: "completed",
        });
        resolve();
      });
    });
  }

  async interrupt(): Promise<void> {
    if (!this.activeChild || !this.activeChild.pid) return;
    this.interrupted = true;
    await terminateProcessTree(this.activeChild.pid);
  }

  async close(): Promise<void> {
    await this.interrupt();
    if (this.attachmentDir !== null) {
      await rm(this.attachmentDir, { recursive: true, force: true });
      this.attachmentDir = null;
    }
  }

  private persistence(): ProviderPersistence {
    if (!this.zcodeSessionId) {
      throw new ZCodeError("ZCode session ID has not been assigned yet");
    }
    return { version: 1, data: { sessionId: this.zcodeSessionId } };
  }

  private publishConfig(): void {
    this.options.emit({
      type: "session.config",
      sessionId: this.options.id,
      config: {
        model: this.config.model,
        mode: this.config.mode || "yolo",
        models: ZCODE_MODELS,
        modes: ZCODE_MODES,
        thinkingOptions: [],
        settings: [],
      },
    });
  }

  private async encodePrompt(prompt: ProviderPrompt): Promise<{
    displayText: string;
    promptText: string;
    attachedFiles: string[];
  }> {
    if (prompt.input.type !== "message") {
      throw new ZCodeError("ZCode supports message input only");
    }
    const textParts: string[] = [];
    const attachedFiles: string[] = [];

    for (const part of prompt.input.content) {
      if (part.type === "text") {
        textParts.push(part.text);
      } else if (part.type === "image") {
        if (this.attachmentDir === null) {
          this.attachmentDir = await mkdtemp(path.join(os.tmpdir(), "paseo-zcode-images-"));
          await chmod(this.attachmentDir, 0o700);
        }
        const ext = part.mimeType.split("/")[1]?.replace("jpeg", "jpg") || "png";
        const file = path.join(this.attachmentDir, `${randomUUID()}.${ext}`);
        await writeFile(file, Buffer.from(part.data, "base64"), { flag: "wx", mode: 0o600 });
        attachedFiles.push(file);
      }
    }

    const displayText = textParts.join("\n");
    return {
      displayText,
      promptText: displayText || "Inspect the attached image(s).",
      attachedFiles,
    };
  }
}

function parseZCodeOutput(raw: string): {
  sessionId?: string;
  text: string;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
} {
  const lines = raw
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let sessionId: string | undefined;
  const textFragments: string[] = [];
  let usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number } | undefined;

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj.session_id === "string") sessionId = obj.session_id;
      else if (typeof obj.sessionId === "string") sessionId = obj.sessionId;

      if (typeof obj.response === "string") textFragments.push(obj.response);
      else if (typeof obj.text === "string") textFragments.push(obj.text);
      else if (typeof obj.content === "string") textFragments.push(obj.content);

      if (obj.usage && typeof obj.usage === "object") {
        const u = obj.usage as Record<string, unknown>;
        usage = {
          inputTokens: Number(u.input_tokens ?? u.prompt_tokens ?? 0),
          outputTokens: Number(u.output_tokens ?? u.completion_tokens ?? 0),
          cachedInputTokens: Number(u.cache_read_tokens ?? u.cached_tokens ?? 0),
        };
      }
    } catch {
      textFragments.push(line);
    }
  }

  return {
    sessionId,
    text: textFragments.join("\n").trim(),
    usage,
  };
}

async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    try {
      await execCommand("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: false });
    } catch {
      // Ignore already exited process
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Ignore ESRCH
  }
}
