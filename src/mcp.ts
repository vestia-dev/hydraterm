import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { InspectionClient } from "./inspection";

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
  };
}

/** Run an MCP stdio bridge to the Hydraterm instance for a project. */
export async function runMcpServer(root: string): Promise<void> {
  const client = new InspectionClient(root);
  const server = new McpServer({ name: "hydraterm", version: "0.1.0" }, {
    instructions: "Use these read-only tools to inspect the processes and terminal output owned by Hydraterm for this project. The MCP remains connected while the Hydraterm instance is stopped. Call list_processes first and check instanceStatus before reading output. Pass a current revision to wait_for_process_output when you only want output observed after that point.",
  });

  server.registerTool("list_processes", {
    description: "Report whether Hydraterm is running for this project and list its managed processes, including status, PID, watcher state, and output revision.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async () => {
    try {
      return textResult(await client.status());
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("get_process_output", {
    description: "Read plain terminal output from one Hydraterm process. Output is bounded and defaults to the last 200 lines.",
    inputSchema: {
      process: z.string().min(1).describe("Exact process name returned by list_processes"),
      tailLines: z.number().int().min(1).max(2_000).optional().describe("Number of trailing lines to return (default 200)"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ process, tailLines }) => {
    try {
      return textResult(await client.request({ method: "output", process, tailLines }));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("wait_for_process_output", {
    description: "Wait for a literal string to appear in a process terminal, useful for checking whether a server becomes ready after a code change.",
    inputSchema: {
      process: z.string().min(1).describe("Exact process name returned by list_processes"),
      pattern: z.string().min(1).describe("Literal text to wait for"),
      timeoutMs: z.number().int().min(0).max(30_000).optional().describe("Maximum wait in milliseconds (default 10000)"),
      afterRevision: z.number().int().min(0).optional().describe("Only match after this output revision"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  }, async ({ process, pattern, timeoutMs, afterRevision }) => {
    try {
      return textResult(await client.request({ method: "wait", process, pattern, timeoutMs, afterRevision }));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("start_process", {
    description: "Start one configured Hydraterm process. If an exited process still owns a PTY, Hydraterm starts it again with fresh terminal state.",
    inputSchema: {
      process: z.string().min(1).describe("Exact process name returned by list_processes"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async ({ process }) => {
    try {
      return textResult(await client.request({ method: "control", process, action: "start" }));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("stop_process", {
    description: "Stop one running Hydraterm process and its descendants.",
    inputSchema: {
      process: z.string().min(1).describe("Exact process name returned by list_processes"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async ({ process }) => {
    try {
      return textResult(await client.request({ method: "control", process, action: "stop" }));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("restart_process", {
    description: "Restart one configured Hydraterm process with fresh terminal state.",
    inputSchema: {
      process: z.string().min(1).describe("Exact process name returned by list_processes"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
  }, async ({ process }) => {
    try {
      return textResult(await client.request({ method: "control", process, action: "restart" }));
    } catch (error) {
      return errorResult(error);
    }
  });

  await server.connect(new StdioServerTransport());
}
