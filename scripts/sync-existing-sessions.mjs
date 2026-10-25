#!/usr/bin/env node

/**
 * Paseo Omni — Automatic Existing Session Importer & Live Watcher
 *
 * Scans local sessions created in:
 *   1. OpenAI Codex (`~/.codex/sessions`, with automatic fallback to `codex-desktop`
 *      mirror if a thread is actively locked by Codex Desktop App)
 *   2. Google Antigravity (`~/.gemini/antigravity` & `~/.gemini/antigravity-cli`)
 *   3. GLM ZCode (`~/.zcode/cli/db/db.sqlite`)
 *   4. DeepSeek Harness (`~/.dsh/sessions`)
 * and imports them into the running Paseo Daemon (`paseo import`) with full
 * conversation history and original titles so they appear immediately on Mobile!
 *
 * Usage:
 *   node --no-warnings scripts/sync-existing-sessions.mjs [--limit 4] [--watch] [--interval 30]
 */

import { execFile } from "node:child_process";
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

function parseArgs(argv) {
  const opts = {
    limitPerProvider: 4,
    watch: false,
    intervalSec: 30,
    dryRun: false,
    providers: ["codex", "antigravity", "zcode", "dsh"],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--limit" && argv[i + 1]) {
      opts.limitPerProvider = Math.max(1, Number.parseInt(argv[i + 1], 10) || 4);
      i += 1;
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

async function runPaseo(runner, args, timeoutMs = 30000) {
  const { stdout } = await execFileAsync(runner.exe, [...runner.prefixArgs, ...args], {
    windowsHide: true,
    shell: runner.shell,
    timeout: timeoutMs,
    env: runner.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

async function fetchAlreadyImportedSet(runner) {
  const imported = new Set();
  try {
    const out = await runPaseo(runner, ["ls", "--json"]);
    const agents = JSON.parse(out);
    if (Array.isArray(agents)) {
      for (const ag of agents) {
        const provider = ag.provider || "";
        const sid =
          ag.labels?.omni_sid ||
          ag.persistence?.sessionId ||
          ag.persistence?.threadId ||
          ag.providerSessionId ||
          "";
        if (provider && sid) {
          imported.add(`${provider}:${sid}`);
        }
        if (sid) {
          imported.add(`*:${sid}`);
        }
      }
    }
  } catch {
    // ignore if daemon empty or unreachable
  }

  const ledgerPath = path.join(homeDir, ".paseo", "omni-imported-sessions.json");
  if (fs.existsSync(ledgerPath)) {
    try {
      const list = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
      if (Array.isArray(list)) {
        for (const key of list) imported.add(key);
      }
    } catch {
      // ignore
    }
  }
  return imported;
}

function saveToLedger(keysToAdd) {
  if (keysToAdd.length === 0) return;
  const ledgerPath = path.join(homeDir, ".paseo", "omni-imported-sessions.json");
  let existing = [];
  if (fs.existsSync(ledgerPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
      if (!Array.isArray(existing)) existing = [];
    } catch {
      existing = [];
    }
  }
  const merged = Array.from(new Set([...existing, ...keysToAdd]));
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

function collectCandidateSessions(opts) {
  const all = [];
  if (opts.providers.includes("codex")) {
    all.push(...listCodexSessions({ limit: opts.limitPerProvider }));
  }
  if (opts.providers.includes("antigravity")) {
    all.push(...listAntigravitySessions({ limit: opts.limitPerProvider }));
  }
  if (opts.providers.includes("zcode")) {
    all.push(...listZCodeSessions({ limit: opts.limitPerProvider }));
  }
  if (opts.providers.includes("dsh")) {
    all.push(...listDshSessions({ limit: opts.limitPerProvider }));
  }
  return all.sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
}

async function importOne(runner, provider, item) {
  const importOut = await runPaseo(runner, [
    "import",
    "--provider",
    provider,
    "--cwd",
    item.cwd,
    "--label",
    `omni_sid=${item.sessionId}`,
    "--json",
    item.sessionId,
  ]);

  let agentId = null;
  try {
    const parsed = JSON.parse(importOut);
    agentId = parsed?.id || parsed?.agentId || parsed?.agent?.id || null;
  } catch {
    // ignore
  }

  if (agentId && item.title) {
    try {
      await runPaseo(runner, ["agent", "update", agentId, "--name", item.title]);
    } catch {
      // ignore optional rename failure
    }
  }

  return agentId;
}

async function syncOnce(opts, runner) {
  const alreadyImported = await fetchAlreadyImportedSet(runner);
  const candidates = collectCandidateSessions(opts);
  const newlyAddedKeys = [];
  let importedCount = 0;

  for (const item of candidates) {
    const key = `${item.provider}:${item.sessionId}`;
    if (alreadyImported.has(key) || alreadyImported.has(`*:${item.sessionId}`)) {
      continue;
    }

    if (opts.dryRun) {
      console.log(
        `[dry-run] Would import [${item.provider}] "${item.title}" (${item.sessionId}) cwd=${item.cwd}`,
      );
      continue;
    }

    try {
      const agentId = await importOne(runner, item.provider, item);
      newlyAddedKeys.push(key);
      newlyAddedKeys.push(`*:${item.sessionId}`);
      importedCount += 1;
      console.log(
        `[ok] Imported [${item.provider}] "${item.title}" -> paseo agent ${agentId || item.sessionId}`,
      );
    } catch (err) {
      const stderr = String(err?.stderr || err?.message || err);
      // If Codex Desktop currently holds an active writer lock on this thread, import via lock-free codex-desktop mirror!
      if (item.provider === "codex" && stderr.includes("active writer")) {
        try {
          const mirrorId = await importOne(runner, "codex-desktop", item);
          newlyAddedKeys.push(`codex-desktop:${item.sessionId}`);
          newlyAddedKeys.push(`*:${item.sessionId}`);
          importedCount += 1;
          console.log(
            `[ok] Imported active Codex Desktop thread via [codex-desktop] "${item.title}" -> paseo agent ${mirrorId || item.sessionId}`,
          );
          continue;
        } catch (mirrorErr) {
          console.warn(
            `[skip] Could not mirror [codex-desktop] ${item.sessionId}: ${String(mirrorErr?.stderr || mirrorErr).split("\n")[0]}`,
          );
          continue;
        }
      }
      console.warn(
        `[skip] Could not import [${item.provider}] ${item.sessionId}: ${stderr.trim().split("\n")[0]}`,
      );
    }
  }

  saveToLedger(newlyAddedKeys);
  return importedCount;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const runner = resolvePaseoRunner();

  console.log("=== Paseo Omni: Syncing Existing Local Sessions to Paseo ===");
  const count = await syncOnce(opts, runner);
  console.log(`=== Sync finished (${count} new sessions imported) ===`);

  if (opts.watch) {
    console.log(
      `[watch] Monitoring local Codex / Antigravity / ZCode / DSH sessions every ${opts.intervalSec}s...`,
    );
    setInterval(() => {
      syncOnce(opts, runner).catch((err) => {
        console.error("[watch] Sync error:", err);
      });
    }, opts.intervalSec * 1000);
  }
}

main().catch((err) => {
  console.error("Failed to sync existing sessions:", err);
  process.exit(1);
});
