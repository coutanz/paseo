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

import { existsSync } from "node:fs";
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

async function syncPaseoDaemonConfig(dryRun) {
  const paseoHome = process.env.PASEO_HOME || path.join(homeDir, ".paseo");
  const filePath = path.join(paseoHome, "config.json");
  const current = await readJsonSafe(filePath);
  const nodeExe = process.execPath;

  current.version = current.version ?? 1;
  current.agents = current.agents ?? {};
  current.agents.providers = current.agents.providers ?? {};

  // 1. Codex: enable Full Access (features are configured in ~/.codex/config.toml
  // so both Paseo 0.10.x and 0.13.x validate config.json cleanly)
  current.agents.providers.codex = {
    enabled: true,
    options: {
      approval_policy: "never",
      sandbox_mode: "danger-full-access",
    },
  };

  // 2. Antigravity (`agy`) via Universal ACP Stdio Bridge (compatible with Paseo 0.10.x & 0.13.x)
  current.agents.providers.antigravity = {
    enabled: true,
    extends: "acp",
    label: "Antigravity (Google)",
    description: "Google Antigravity CLI with Windows Computer Use & Browser Use MCP",
    command: [nodeExe, acpBridgePath, "antigravity"],
  };

  // 3. GLM ZCode (`zcode`) via Universal ACP Stdio Bridge
  current.agents.providers.zcode = {
    enabled: true,
    extends: "acp",
    label: "ZCode (GLM)",
    description: "Z.AI GLM-5.3 ZCode CLI with Windows Computer Use & Browser Use MCP",
    command: [nodeExe, acpBridgePath, "zcode"],
  };

  // 4. DeepSeek Harness (`dsh`) via Universal ACP Stdio Bridge
  current.agents.providers.dsh = {
    enabled: true,
    extends: "acp",
    label: "DeepSeek DSH",
    description: "DeepSeek V4.1 Harness CLI with Windows Computer Use & Browser Use MCP",
    command: [nodeExe, acpBridgePath, "dsh"],
  };

  await writeJsonFile(filePath, current, dryRun);
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
