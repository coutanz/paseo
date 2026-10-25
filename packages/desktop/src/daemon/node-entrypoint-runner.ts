import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function maybeRunOmniBootPresync(entryPath: string, args: string[]): Promise<void> {
  try {
    const normEntry = String(entryPath || "").replace(/\\/g, "/").toLowerCase();
    const isDaemonWorker =
      normEntry.endsWith("/daemon-worker.js") ||
      normEntry.endsWith("/daemon-worker.ts") ||
      normEntry.endsWith("/supervisor-entrypoint.js") ||
      normEntry.endsWith("/supervisor-entrypoint.ts");
    const isCliDaemonCmd =
      normEntry.endsWith("/@getpaseo/cli/dist/index.js") &&
      args[0] === "daemon" &&
      (args[1] === "start" || args[1] === "restart");

    if (!isDaemonWorker && !isCliDaemonCmd) {
      return;
    }

    if (isDaemonWorker) {
      process.env.PASEO_DESKTOP_MANAGED = "1";
    }

    const origEmitWarning = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const msg = typeof warning === "string" ? warning : (warning?.message ?? "");
      if (msg.includes("SQLite is an experimental feature")) return;
      return (origEmitWarning as (...a: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;

    const syncScriptPath =
      process.env.PASEO_OMNI_SYNC_SCRIPT ||
      path.join(
        os.homedir(),
        ".gemini",
        "antigravity",
        "scratch",
        "paseo",
        "scripts",
        "sync-existing-sessions.mjs",
      );
    if (!existsSync(syncScriptPath)) {
      return;
    }

    const mod = (await import(pathToFileURL(syncScriptPath).href)) as {
      runBootPresync?: (opts?: Record<string, unknown>) => Promise<unknown>;
    };
    if (typeof mod.runBootPresync === "function") {
      await Promise.race([
        mod.runBootPresync({
          quiet: true,
          throttleMs: 1500,
        }),
        new Promise((resolve) => setTimeout(resolve, 4500)),
      ]);
    }
  } catch {
    // 预同步异常绝不阻塞 Paseo Daemon 正常启动
  }
}

export async function main(): Promise<void> {
  const [argvMode, entryPath, ...args] = process.argv.slice(2);
  if (argvMode !== "bare" && argvMode !== "node-script") {
    throw new Error(`Unsupported node entrypoint argv mode: ${argvMode ?? "<missing>"}`);
  }
  if (!entryPath) {
    throw new Error("Missing node entrypoint path.");
  }

  await maybeRunOmniBootPresync(entryPath, args);

  process.argv =
    argvMode === "bare"
      ? [process.argv[0] ?? "node", ...args]
      : [process.argv[0] ?? "node", entryPath, ...args];
  await import(pathToFileURL(entryPath).href);
}

if (require.main === module) {
  void main().catch((error) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
