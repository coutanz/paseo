#!/usr/bin/env node

/**
 * Paseo Omni — Cross-Agent Computer Use & Browser Use MCP Synchronizer
 *
 * Unifies Windows/macOS Computer Use (`windows-mcp`, `open-computer-use`)
 * and Browser Use (`@playwright/mcp`) across all 4 target agent harnesses:
 *   1. OpenAI Codex CLI (`~/.codex/config.toml`)
 *   2. Google Antigravity CLI (`~/.gemini/antigravity-cli/settings.json`)
 *   3. GLM ZCode CLI (`~/.zcode/cli/config.json` & `~/.zcode/cli/setting.json`)
 *   4. DeepSeek Harness CLI (`~/.dsh/config.json`)
 *   5. Paseo Daemon Config (`~/.paseo/config.json`)
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const isWin = process.platform === "win32";
const homeDir = os.homedir();
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const acpBridgePath = path.join(scriptDir, "omni-acp-bridge.mjs");
const npxBin = isWin ? "npx.cmd" : "npx";
const uvxBin = isWin ? "uvx.exe" : "uvx";

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    cdpEndpoint: process.env.PASEO_CHROME_CDP_URL || "",
    enableOpenComputerUse: true,
    enableWindowsMcp: isWin,
    enablePlaywrightMcp: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--cdp-endpoint" && argv[i + 1]) {
      opts.cdpEndpoint = argv[i + 1];
      i += 1;
    } else if (arg === "--no-windows-mcp") opts.enableWindowsMcp = false;
    else if (arg === "--no-open-computer-use") opts.enableOpenComputerUse = false;
    else if (arg === "--no-browser-use") opts.enablePlaywrightMcp = false;
  }
  return opts;
}

function buildStandardMcpServers(opts) {
  const servers = {};

  if (opts.enableWindowsMcp) {
    servers["windows-desktop"] = {
      type: "stdio",
      command: uvxBin,
      args: ["windows-mcp"],
    };
  }

  if (opts.enableOpenComputerUse) {
    servers["computer-use"] = {
      type: "stdio",
      command: npxBin,
      args: ["-y", "@qwen-code/open-computer-use", "mcp"],
    };
  }

  if (opts.enablePlaywrightMcp) {
    const pwArgs = ["-y", "@playwright/mcp@latest"];
    if (opts.cdpEndpoint) {
      pwArgs.push("--cdp-endpoint", opts.cdpEndpoint);
    }
    servers["browser-use"] = {
      type: "stdio",
      command: npxBin,
      args: pwArgs,
    };
  }

  return servers;
}

async function readJsonSafe(filePath) {
  if (!existsSync(filePath)) return {};
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function backupOnce(filePath, dryRun) {
  if (dryRun || !existsSync(filePath)) return;
  const bakPath = `${filePath}.paseo.bak`;
  if (!existsSync(bakPath)) {
    await copyFile(filePath, bakPath);
  }
}

async function writeJsonFile(filePath, data, dryRun) {
  const formatted = `${JSON.stringify(data, null, 2)}\n`;
  if (dryRun) {
    console.log(`[dry-run] Would write ${filePath}:\n${formatted}`);
    return;
  }
  await backupOnce(filePath, dryRun);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, formatted, "utf8");
  console.log(`[ok] Updated ${filePath}`);
}

async function syncAntigravityConfig(mcpServers, dryRun) {
  const filePath = path.join(homeDir, ".gemini", "antigravity-cli", "settings.json");
  const current = await readJsonSafe(filePath);
  current.mcpServers = {
    ...(current.mcpServers || {}),
    ...mcpServers,
  };
  await writeJsonFile(filePath, current, dryRun);
}

async function syncZCodeConfig(mcpServers, dryRun) {
  // 1. Primary ZCode 0.17+ CLI config (`~/.zcode/cli/config.json`)
  const configPath = path.join(homeDir, ".zcode", "cli", "config.json");
  const currentConfig = await readJsonSafe(configPath);
  currentConfig.mcp = currentConfig.mcp || {};
  currentConfig.mcp.servers = {
    ...(currentConfig.mcp.servers || {}),
    ...mcpServers,
  };
  currentConfig.plugins = currentConfig.plugins || {};
  currentConfig.plugins.enabledPlugins = {
    ...(currentConfig.plugins.enabledPlugins || {}),
    "computer-use@zcode-plugins-official": true,
  };
  await writeJsonFile(configPath, currentConfig, dryRun);

  // 2. Legacy / alternative ZCode setting file (`~/.zcode/cli/setting.json`)
  const settingPath = path.join(homeDir, ".zcode", "cli", "setting.json");
  const currentSetting = await readJsonSafe(settingPath);
  currentSetting.mcpServers = {
    ...(currentSetting.mcpServers || {}),
    ...mcpServers,
  };
  await writeJsonFile(settingPath, currentSetting, dryRun);
}

async function syncDshConfig(mcpServers, dryRun) {
  const filePath = path.join(homeDir, ".dsh", "config.json");
  const current = await readJsonSafe(filePath);
  current.mcpServers = {
    ...(current.mcpServers || {}),
    ...mcpServers,
  };
  await writeJsonFile(filePath, current, dryRun);

  // Install @paseo-omni/dsh-desktop-connector into ~/.dsh/profiles/desktop for live App bridge
  const connectorSrc = path.join(scriptDir, "dsh-paseo-connector.mjs");
  const desktopProfileDir = path.join(homeDir, ".dsh", "profiles", "desktop");
  if (!dryRun && existsSync(connectorSrc) && existsSync(desktopProfileDir)) {
    try {
      const pkgDir = path.join(
        desktopProfileDir,
        "node_modules",
        "@paseo-omni",
        "dsh-desktop-connector",
      );
      await mkdir(pkgDir, { recursive: true });
      await copyFile(connectorSrc, path.join(pkgDir, "index.mjs"));
      const pkgJson = {
        name: "@paseo-omni/dsh-desktop-connector",
        version: "1.0.0",
        type: "module",
        main: "./index.mjs",
        exports: "./index.mjs",
      };
      await writeFile(path.join(pkgDir, "package.json"), `${JSON.stringify(pkgJson, null, 2)}\n`, "utf8");

      const desktopPatchYml = path.join(desktopProfileDir, "cordis.patch.yml");
      if (existsSync(desktopPatchYml)) {
        const ymlText = await readFile(desktopPatchYml, "utf8");
        const descriptorPath = path.join(homeDir, ".paseo", "dsh-desktop-connector.json");
        if (!ymlText.includes("@paseo-omni/dsh-desktop-connector")) {
          await backupOnce(desktopPatchYml, false);
          const snippet = [
            "  - id: paseo-omni-dsh-desktop",
            '    name: "@paseo-omni/dsh-desktop-connector"',
            "    config:",
            `      descriptorPath: ${JSON.stringify(descriptorPath)}`,
          ].join("\n");
          await writeFile(desktopPatchYml, `${ymlText.trimEnd()}\n${snippet}\n`, "utf8");
          console.log(`[ok] Injected @paseo-omni/dsh-desktop-connector into ${desktopPatchYml}`);
        }

        // Also sync model provider config to headless profile if headless cordis.patch.yml is empty
        const headlessPatchYml = path.join(homeDir, ".dsh", "profiles", "headless", "cordis.patch.yml");
        if (existsSync(headlessPatchYml)) {
          const headlessText = await readFile(headlessPatchYml, "utf8");
          if (headlessText.trim() === "plugins: []") {
            const cutIdx = ymlText.indexOf("  - id: codexbridge-dsh-desktop");
            const providerOnlyYml =
              cutIdx !== -1 ? `${ymlText.slice(0, cutIdx).trimEnd()}\n` : ymlText;
            await writeFile(headlessPatchYml, providerOnlyYml, "utf8");
            console.log(`[ok] Synchronized DSH model provider config to ${headlessPatchYml}`);
          }
        }
      }
    } catch (err) {
      console.warn("[warn] Failed to install DSH Desktop Cordis connector:", err);
    }
  }
}

function ensureCodexFeaturesInToml(tomlText) {
  const featuresHeaderRegex = /^\s*\[features\]\s*$/m;
  const match = featuresHeaderRegex.exec(tomlText);
  if (!match) {
    return { text: tomlText, hadFeaturesSection: false };
  }

  const headerEnd = match.index + match[0].length;
  const rest = tomlText.slice(headerEnd);
  const nextSectionMatch = /^\s*\[[^\]]+\]/m.exec(rest);
  const sectionBodyEnd = nextSectionMatch ? headerEnd + nextSectionMatch.index : tomlText.length;

  let sectionBody = tomlText.slice(headerEnd, sectionBodyEnd);
  const requiredFlags = {
    js_repl: "true",
    computer_use: "true",
    browser_use: "true",
    plugins: "true",
  };

  for (const [key, val] of Object.entries(requiredFlags)) {
    const keyRegex = new RegExp(`^(\\s*${key}\\s*=\\s*).*$`, "m");
    if (keyRegex.test(sectionBody)) {
      sectionBody = sectionBody.replace(keyRegex, `$1${val}`);
    } else {
      sectionBody = `\n${key} = ${val}${sectionBody}`;
    }
  }

  const updated = `${tomlText.slice(0, headerEnd)}${sectionBody}${tomlText.slice(sectionBodyEnd)}`;
  return { text: updated, hadFeaturesSection: true };
}

async function syncCodexToml(opts, mcpServers, dryRun) {
  const filePath = path.join(homeDir, ".codex", "config.toml");
  let existing = "";
  if (existsSync(filePath)) {
    existing = await readFile(filePath, "utf8");
  }

  const markerStart = "# >>> paseo-omni computer-use & browser-use start >>>";
  const markerEnd = "# <<< paseo-omni computer-use & browser-use end <<<";

  // Strip old marker block first so we inspect clean TOML
  let baseToml = existing;
  if (baseToml.includes(markerStart) && baseToml.includes(markerEnd)) {
    const startIdx = baseToml.indexOf(markerStart);
    const endIdx = baseToml.indexOf(markerEnd) + markerEnd.length;
    baseToml = `${baseToml.slice(0, startIdx).trimEnd()}\n${baseToml.slice(endIdx).trimStart()}`;
  }

  const { text: tomlWithFeatures, hadFeaturesSection } = ensureCodexFeaturesInToml(baseToml);

  const lines = [markerStart];
  if (!hadFeaturesSection) {
    lines.push(
      "[features]",
      "js_repl = true",
      "computer_use = true",
      "browser_use = true",
      "plugins = true",
      "",
    );
  }

  for (const [name, srv] of Object.entries(mcpServers)) {
    const safeKey = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    lines.push(`[mcp_servers.${safeKey}]`);
    lines.push(`command = ${JSON.stringify(srv.command)}`);
    lines.push(`args = ${JSON.stringify(srv.args)}`);
    lines.push("");
  }
  lines.push(markerEnd);
  const block = lines.join("\n");

  const updated = `${tomlWithFeatures.trimEnd()}\n\n${block}\n`.trimStart();

  if (dryRun) {
    console.log(`[dry-run] Would write ${filePath}:\n${updated}`);
    return;
  }
  await backupOnce(filePath, dryRun);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, updated, "utf8");
  console.log(`[ok] Updated ${filePath}`);
}

function resolveWindowsCodexExe() {
  if (!isWin) return null;
  const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
  const codexBinRoot = path.join(localAppData, "OpenAI", "Codex", "bin");
  if (!existsSync(codexBinRoot)) return null;
  try {
    const candidates = readdirSync(codexBinRoot)
      .map((sub) => path.join(codexBinRoot, sub, "codex.exe"))
      .filter((p) => existsSync(p))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return candidates[0] || null;
  } catch {
    return null;
  }
}

async function syncPaseoDaemonConfig(dryRun) {
  const paseoHome = process.env.PASEO_HOME || path.join(homeDir, ".paseo");
  const filePath = path.join(paseoHome, "config.json");
  const current = await readJsonSafe(filePath);
  const nodeExe = process.execPath;
  const codexExe = resolveWindowsCodexExe();

  current.version = current.version ?? 1;
  current.agents = current.agents ?? {};
  current.agents.providers = current.agents.providers ?? {};

  // 1. Codex: enable Full Access + bind resolved codex.exe path on Windows
  current.agents.providers.codex = {
    enabled: true,
    ...(codexExe ? { command: [codexExe] } : {}),
    options: {
      approval_policy: "never",
      sandbox_mode: "danger-full-access",
    },
  };

  // 1b. Codex Desktop Mirror (read-only lock-free mirror for threads actively open in Codex Desktop)
  current.agents.providers["codex-desktop"] = {
    enabled: true,
    extends: "acp",
    label: "Codex (Desktop Mirror)",
    description: "Lock-free mirror for active Codex Desktop conversations",
    command: [nodeExe, "--no-warnings", acpBridgePath, "codex-desktop"],
  };

  // 2. Antigravity (`agy`) via Universal ACP Stdio Bridge (compatible with Paseo 0.10.x & 0.13.x)
  current.agents.providers.antigravity = {
    enabled: true,
    extends: "acp",
    label: "Antigravity (Google)",
    description: "Google Antigravity CLI with Windows Computer Use & Browser Use MCP",
    command: [nodeExe, "--no-warnings", acpBridgePath, "antigravity"],
  };

  // 3. GLM ZCode (`zcode`) via Universal ACP Stdio Bridge
  current.agents.providers.zcode = {
    enabled: true,
    extends: "acp",
    label: "ZCode (GLM)",
    description: "Z.AI GLM-5.3 ZCode CLI with Windows Computer Use & Browser Use MCP",
    command: [nodeExe, "--no-warnings", acpBridgePath, "zcode"],
  };

  // 4. DeepSeek Harness (`dsh`) via Universal ACP Stdio Bridge
  current.agents.providers.dsh = {
    enabled: true,
    extends: "acp",
    label: "DeepSeek DSH",
    description: "DeepSeek V4.1 Harness CLI with Windows Computer Use & Browser Use MCP",
    command: [nodeExe, "--no-warnings", acpBridgePath, "dsh"],
  };

  await writeJsonFile(filePath, current, dryRun);

  // 5. 自动注入 Paseo Desktop 内置 Daemon 启动前预同步钩子 (node-entrypoint-runner.js)
  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
    const runnerJsPath = path.join(
      localAppData,
      "Programs",
      "Paseo",
      "resources",
      "app.asar.unpacked",
      "dist",
      "daemon",
      "node-entrypoint-runner.js",
    );
    const syncSessionsScriptPath = path.join(scriptDir, "sync-existing-sessions.mjs");
    if (existsSync(runnerJsPath) && !dryRun) {
      const runnerCode = [
        '"use strict";',
        'Object.defineProperty(exports, "__esModule", { value: true });',
        "exports.main = main;",
        'const node_fs_1 = require("node:fs");',
        'const node_os_1 = require("node:os");',
        'const node_path_1 = require("node:path");',
        'const node_url_1 = require("node:url");',
        "async function maybeRunOmniBootPresync(entryPath, args) {",
        "    try {",
        '        const normEntry = String(entryPath || "").replace(/\\\\/g, "/").toLowerCase();',
        '        const isDaemonWorker = normEntry.endsWith("/daemon-worker.js") ||',
        '            normEntry.endsWith("/daemon-worker.ts") ||',
        '            normEntry.endsWith("/supervisor-entrypoint.js") ||',
        '            normEntry.endsWith("/supervisor-entrypoint.ts");',
        '        const isCliDaemonCmd = normEntry.endsWith("/@getpaseo/cli/dist/index.js") &&',
        '            args[0] === "daemon" &&',
        '            (args[1] === "start" || args[1] === "restart");',
        "        if (!isDaemonWorker && !isCliDaemonCmd) {",
        "            return;",
        "        }",
        "        if (isDaemonWorker) {",
        '            process.env.PASEO_DESKTOP_MANAGED = "1";',
        "        }",
        "        const origEmitWarning = process.emitWarning;",
        "        process.emitWarning = function (warning, ...rest) {",
        '            const msg = typeof warning === "string" ? warning : (warning?.message ?? "");',
        '            if (msg.includes("SQLite is an experimental feature"))',
        "                return;",
        "            return origEmitWarning.call(process, warning, ...rest);",
        "        };",
        `        const syncScriptPath = process.env.PASEO_OMNI_SYNC_SCRIPT || ${JSON.stringify(syncSessionsScriptPath)} || node_path_1.join(node_os_1.homedir(), ".gemini", "antigravity", "scratch", "paseo", "scripts", "sync-existing-sessions.mjs");`,
        "        if (!(0, node_fs_1.existsSync)(syncScriptPath)) {",
        "            return;",
        "        }",
        "        const mod = await import((0, node_url_1.pathToFileURL)(syncScriptPath).href);",
        '        if (typeof mod.runBootPresync === "function") {',
        "            await Promise.race([",
        "                mod.runBootPresync({",
        "                    quiet: true,",
        "                    throttleMs: 1500,",
        "                }),",
        "                new Promise((resolve) => setTimeout(resolve, 4500)),",
        "            ]);",
        "        }",
        "    }",
        "    catch {",
        "        // 预同步异常绝不阻塞 Paseo Daemon 正常启动",
        "    }",
        "}",
        "async function main() {",
        "    const [argvMode, entryPath, ...args] = process.argv.slice(2);",
        '    if (argvMode !== "bare" && argvMode !== "node-script") {',
        '        throw new Error(`Unsupported node entrypoint argv mode: ${argvMode ?? "<missing>"}`);',
        "    }",
        "    if (!entryPath) {",
        '        throw new Error("Missing node entrypoint path.");',
        "    }",
        "    await maybeRunOmniBootPresync(entryPath, args);",
        "    process.argv =",
        '        argvMode === "bare"',
        '            ? [process.argv[0] ?? "node", ...args]',
        '            : [process.argv[0] ?? "node", entryPath, ...args];',
        "    await import((0, node_url_1.pathToFileURL)(entryPath).href);",
        "}",
        "if (require.main === module) {",
        "    void main().catch((error) => {",
        "        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);",
        "        process.stderr.write(`${message}\\n`);",
        "        process.exit(1);",
        "    });",
        "}",
        "//# sourceMappingURL=node-entrypoint-runner.js.map",
        "",
      ].join("\n");
      await backupOnce(runnerJsPath, dryRun);
      await writeFile(runnerJsPath, runnerCode, "utf8");
      console.log(`[ok] Injected Omni boot pre-sync hook into ${runnerJsPath}`);
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const mcpServers = buildStandardMcpServers(opts);

  console.log("=== Paseo Omni: Synchronizing Computer Use & Browser Use MCP ===");
  console.log(`Platform: ${process.platform} (${os.release()})`);
  console.log(`Injected MCP Servers: ${Object.keys(mcpServers).join(", ")}`);

  await syncCodexToml(opts, mcpServers, opts.dryRun);
  await syncAntigravityConfig(mcpServers, opts.dryRun);
  await syncZCodeConfig(mcpServers, opts.dryRun);
  await syncDshConfig(mcpServers, opts.dryRun);
  await syncPaseoDaemonConfig(opts.dryRun);

  console.log("=== All 4 Agent CLIs & Paseo Daemon synchronized successfully! ===");
}

main().catch((error) => {
  console.error("Failed to synchronize Computer Use MCP configs:", error);
  process.exit(1);
});
