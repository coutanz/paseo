#!/usr/bin/env node

/**
 * Paseo Omni — NetBird Multi-Machine Swarm Orchestrator MCP Server
 *
 * Allows any primary agent (Antigravity, Codex, ZCode, DSH) on your main desktop
 * to discover, dispatch, and coordinate tasks across multiple Windows/macOS machines
 * over NetBird via Paseo's WebSocket Daemon API (`@getpaseo/client`).
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createPaseoClient } from "../packages/client/dist/index.js";

const paseoHome = process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
const nodesFile = path.join(paseoHome, "swarm-nodes.json");

async function loadNodes() {
  const defaultNodes = {
    local: {
      id: "local",
      label: "Local Host",
      url: process.env.PASEO_LOCAL_URL || "ws://127.0.0.1:6767/ws",
      os: process.platform,
    },
  };
  if (!existsSync(nodesFile)) {
    return defaultNodes;
  }
  try {
    const raw = JSON.parse(await readFile(nodesFile, "utf8"));
    return { ...defaultNodes, ...raw };
  } catch {
    return defaultNodes;
  }
}

async function saveNodes(nodes) {
  await mkdir(path.dirname(nodesFile), { recursive: true });
  await writeFile(nodesFile, `${JSON.stringify(nodes, null, 2)}\n`, "utf8");
}

async function withNodeClient(nodeUrl, fn) {
  const client = createPaseoClient({ url: nodeUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

const server = new Server(
  {
    name: "paseo-omni-swarm",
    version: "0.13.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "paseo_swarm_list_nodes",
      description:
        "List all registered NetBird / Paseo daemon nodes (Windows & macOS machines) available for multi-agent orchestration.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "paseo_swarm_register_node",
      description:
        "Register or update a remote Windows/macOS machine running Paseo Daemon over NetBird (e.g. ws://100.x.x.x:6767/ws).",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Unique node identifier (e.g., 'win-desktop-01', 'mac-studio')",
          },
          label: { type: "string", description: "Human-readable name of the machine" },
          url: {
            type: "string",
            description: "WebSocket URL on NetBird IP (e.g. 'ws://100.119.1.10:6767/ws')",
          },
          os: { type: "string", description: "Operating system ('win32', 'darwin', 'linux')" },
        },
        required: ["id", "url"],
      },
    },
    {
      name: "paseo_swarm_dispatch_agent",
      description:
        "Dispatch a coding or Windows/macOS Computer Use task to a specific agent (zcode, codex, antigravity, dsh) on a target NetBird machine.",
      inputSchema: {
        type: "object",
        properties: {
          nodeId: {
            type: "string",
            description: "Target machine node ID from paseo_swarm_list_nodes (default: 'local')",
          },
          provider: {
            type: "string",
            description:
              "Agent provider and optional model (e.g. 'zcode/glm-5.3', 'codex/gpt-5.5', 'antigravity', 'dsh')",
          },
          cwd: {
            type: "string",
            description: "Working directory path on the target remote machine",
          },
          prompt: {
            type: "string",
            description: "Task instructions (can include Windows Computer Use GUI actions or code tasks)",
          },
          modeId: {
            type: "string",
            description:
              "Permission mode (e.g. 'yolo' for ZCode, 'full-access' for Codex/Antigravity)",
          },
        },
        required: ["provider", "cwd", "prompt"],
      },
    },
    {
      name: "paseo_swarm_list_remote_agents",
      description: "List active or recent agent sessions on a target NetBird Paseo node.",
      inputSchema: {
        type: "object",
        properties: {
          nodeId: {
            type: "string",
            description: "Target machine node ID (default: 'local')",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const nodes = await loadNodes();

  if (name === "paseo_swarm_list_nodes") {
    return {
      content: [{ type: "text", text: JSON.stringify(nodes, null, 2) }],
    };
  }

  if (name === "paseo_swarm_register_node") {
    const id = String(args.id);
    const url = String(args.url).endsWith("/ws") ? String(args.url) : `${String(args.url)}/ws`;
    nodes[id] = {
      id,
      label: args.label ? String(args.label) : id,
      url,
      os: args.os ? String(args.os) : "win32",
    };
    await saveNodes(nodes);
    return {
      content: [{ type: "text", text: `Registered node '${id}' -> ${url}` }],
    };
  }

  if (name === "paseo_swarm_dispatch_agent") {
    const nodeId = args.nodeId ? String(args.nodeId) : "local";
    const targetNode = nodes[nodeId];
    if (!targetNode) {
      throw new Error(`Unknown nodeId '${nodeId}'. Register it first with paseo_swarm_register_node.`);
    }

    const result = await withNodeClient(targetNode.url, async (client) => {
      const agent = await client.agents.create({
        config: {
          provider: String(args.provider),
          ...(args.modeId ? { modeId: String(args.modeId) } : {}),
        },
        cwd: String(args.cwd),
        prompt: String(args.prompt),
      });
      const finish = await agent.waitForFinish();
      return {
        nodeId,
        agentId: agent.id,
        status: finish.status,
        lastMessage: finish.lastMessage,
      };
    });

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  }

  if (name === "paseo_swarm_list_remote_agents") {
    const nodeId = args.nodeId ? String(args.nodeId) : "local";
    const targetNode = nodes[nodeId];
    if (!targetNode) {
      throw new Error(`Unknown nodeId '${nodeId}'.`);
    }

    const list = await withNodeClient(targetNode.url, async (client) => {
      return await client.agents.list();
    });

    return {
      content: [{ type: "text", text: JSON.stringify(list, null, 2) }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Paseo Omni Swarm MCP error:", error);
  process.exit(1);
});
