import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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
  "session.configure",
  "session.persistence",
] as const;

const DSH_MODELS: readonly ProviderModel[] = [
  { id: "DeepSeek-V4.1-Flash", label: "DeepSeek V4.1 Flash (1M Context + Vision)" },
  { id: "DeepSeek-V4-Flash", label: "DeepSeek V4 Flash" },
  { id: "deepseek-chat", label: "DeepSeek Chat (V3/V4)" },
  { id: "deepseek-reasoner", label: "DeepSeek Reasoner (R1/R2)" },
];

const DSH_MODES: readonly ProviderMode[] = [
  {
    id: "headless",
    icon: "ShieldOff",
    colorTier: "dangerous",
    label: "Headless Full Access",
    description:
      "Runs DeepSeek Harness via `dsh --profile headless --json` with full local tool and Computer Use execution.",
    isUnattended: true,
  },
];

const DSH_CATALOG: ProviderCatalog = {
  models: DSH_MODELS,
  modes: DSH_MODES,
  thinkingOptions: [],
  defaultMode: "headless",
};

const persistenceSchema = z
  .object({
    version: z.literal(1),
    data: z.object({ sessionId: z.string().min(1) }).strict(),
  })
  .strict();

class DshError extends Error {
  constructor(
    message: string,
    readonly code = "DSH_ERROR",
  ) {
    super(message);
    this.name = "DshError";
  }
}

function resolveDefaultDshCommand(): readonly string[] {
  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const candidates = [
      "E:\\DSH\\resources\\runtime\\cli\\bin\\dsh.cmd",
      "C:\\DSH\\resources\\runtime\\cli\\bin\\dsh.cmd",
      path.join(localAppData, "Programs", "DSH", "resources", "runtime", "cli", "bin", "dsh.cmd"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return [candidate];
      }
    }
  }
  return ["dsh"];
}

export function createDshProvider(): ProviderRegistration {
  return {
    id: "dsh",
    label: "DeepSeek DSH",
    icon: "icon.svg",
    command: resolveDefaultDshCommand(),
    description: "DeepSeek Harness CLI (`dsh --profile headless --json`) with Cordis plugin stack",
    async status({ launch }) {
      if (!launch) {
        return {
          available: false,
          diagnostic:
            "dsh not found on PATH. Run `npm run omni:sync-mcp` to auto-bind your installed DeepSeek Harness (`E:\\DSH\\resources\\runtime\\cli\\bin\\dsh.cmd`).",
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
        throw new DshError("Provider protocol version 1 is required");
      }
      if (!request.launch) {
        throw new DshError("The daemon must supply the DSH launch");
      }
      const negotiated = negotiateProviderCapabilities(request.capabilities, capabilities);
      return createDshConnection(request.launch, negotiated);
    },
  };
}

function createDshConnection(
  launch: ProviderLaunch,
  negotiated: readonly string[],
): ProviderConnection {
  const sessions = new Map<string, DshSession>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  let closed = false;
  let pending = Promise.resolve();

  function emit(event: ProviderEvent): void {
    if (closed) return;
    for (const listener of listeners) listener(event);
  }

  function getSession(id: string): DshSession {
    const found = sessions.get(id);
    if (!found) throw new DshError(`Unknown DSH session: ${id}`);
    return found;
  }

  async function dispatch(input: ProviderInput): Promise<void> {
    switch (input.type) {
      case "catalog":
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: DSH_CATALOG,
        });
        return;
      case "session.open": {
        if (sessions.has(input.sessionId)) {
          throw new DshError(`Session already exists: ${input.sessionId}`);
        }
        const opened = new DshSession({
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
        throw new DshError(`Unsupported DSH operation: ${input.type}`);
    }
    emit({ type: "request.completed", requestId: input.requestId });
  }

  function failed(input: ProviderInput, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof DshError ? error.code : "DSH_ERROR";
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
      if (closed) throw new DshError("DSH connection is closed");
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

interface DshSessionOptions {
  id: string;
  config: ProviderSessionConfig;
  launch: ProviderLaunch;
  persistence?: ProviderPersistence;
  emit(event: ProviderEvent): void;
}

class DshSession {
  private config: ProviderSessionConfig;
  private dshSessionId: string | null;
  private firstMessage: boolean;
  private activeChild: ChildProcessWithoutNullStreams | null = null;
  private interrupted = false;

  constructor(private readonly options: DshSessionOptions) {
    this.config = {
      ...options.config,
      model: options.config.model ?? "DeepSeek-V4.1-Flash",
      mode: options.config.mode ?? "headless",
    };
    this.dshSessionId = options.persistence
      ? persistenceSchema.parse(options.persistence).data.sessionId
      : null;
    this.firstMessage = this.dshSessionId === null;
  }

  open(requestId: string, negotiatedCapabilities: readonly string[]): void {
    this.options.emit({
      type: "session.opened",
      requestId,
      sessionId: this.options.id,
      capabilities: negotiatedCapabilities,
      restoration: "core",
      persistence:
        this.config.persist && this.dshSessionId ? this.persistence() : undefined,
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
      mode: changes.mode === null ? "headless" : (changes.mode ?? this.config.mode),
    };
    this.publishConfig();
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (this.activeChild !== null) {
      throw new DshError("DSH already has an active turn; wait for it to finish", "TURN_ACTIVE");
    }
    if (prompt.input.type !== "message" || prompt.delivery === "steer") {
      throw new DshError("DSH supports standard message prompts only");
    }

    const displayText = prompt.input.content
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("\n");

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
        ? `${this.config.systemPrompt}\n\n${displayText}`
        : displayText;

    // Matches real `dsh --profile headless --help`: dsh --profile headless --json [--session-id <id>] <task>
    const args = [...this.options.launch.args, "--profile", "headless", "--json"];
    if (!this.firstMessage && this.dshSessionId) {
      args.push("--session-id", this.dshSessionId);
    }
    args.push(fullPrompt);

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
              message: stderr.trim() || `DSH exited with code ${code}`,
              code: "PROCESS_EXIT",
            },
          });
          resolve();
          return;
        }

        const parsed = parseDshEvents(stdout);
        if (parsed.sessionId) {
          this.dshSessionId = parsed.sessionId;
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
  }

  private persistence(): ProviderPersistence {
    if (!this.dshSessionId) {
      throw new DshError("DSH session ID has not been assigned yet");
    }
    return { version: 1, data: { sessionId: this.dshSessionId } };
  }

  private publishConfig(): void {
    this.options.emit({
      type: "session.config",
      sessionId: this.options.id,
      config: {
        model: this.config.model,
        mode: this.config.mode || "headless",
        models: DSH_MODELS,
        modes: DSH_MODES,
        thinkingOptions: [],
        settings: [],
      },
    });
  }
}

function parseDshEvents(raw: string): { sessionId?: string; text: string } {
  const lines = raw
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let sessionId: string | undefined;
  const textFragments: string[] = [];

  for (const line of lines) {
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj.sessionId === "string") sessionId = obj.sessionId;
      else if (typeof obj.session_id === "string") sessionId = obj.session_id;

      if (typeof obj.text === "string") textFragments.push(obj.text);
      else if (typeof obj.content === "string") textFragments.push(obj.content);
      else if (typeof obj.message === "string") textFragments.push(obj.message);
      else if (typeof obj.result === "string") textFragments.push(obj.result);
    } catch {
      textFragments.push(line);
    }
  }

  return {
    sessionId,
    text: textFragments.join("\n").trim(),
  };
}

async function terminateProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    try {
      await execCommand("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: false });
    } catch {
      // Ignore already exited
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Ignore ESRCH
  }
}
