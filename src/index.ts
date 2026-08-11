#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createMcpHandler,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  McpServer,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "auth-mcp-test-server",
    version: "1.0.0",
  });

  server.registerTool(
    "echo",
    {
      description: "Return the supplied text. Useful for checking MCP connectivity.",
      inputSchema: z.object({
        message: z.string().describe("Text to echo"),
      }),
    },
    async ({ message }) => ({
      content: [{ type: "text", text: message }],
      structuredContent: { message },
    }),
  );

  server.registerTool(
    "add",
    {
      description: "Add two numbers and return their sum.",
      inputSchema: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
      }),
    },
    async ({ a, b }) => {
      const sum = a + b;
      return {
        content: [{ type: "text", text: String(sum) }],
        structuredContent: { sum },
      };
    },
  );

  return server;
}

function toWebRequest(req: IncomingMessage): Request {
  const origin = `http://${req.headers.host ?? `${host}:${port}`}`;
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : req;

  return new Request(new URL(req.url ?? "/", origin), {
    method: req.method,
    headers: new Headers(req.headers as HeadersInit),
    body,
    duplex: body ? "half" : undefined,
  } as RequestInit);
}

async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
}

async function main(): Promise<void> {
  // One factory serves both the current protocol and stateless 2025-era clients.
  const mcpHandler = createMcpHandler(createMcpServer, {
    legacy: "stateless",
    onerror: (error) => console.error("MCP error:", error),
  });

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${host}:${port}`}`);

      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not Found");
        return;
      }

      const request = toWebRequest(req);
      const rejected =
        hostHeaderValidationResponse(request, localhostAllowedHostnames()) ??
        originValidationResponse(request, localhostAllowedOrigins());

      await sendWebResponse(res, rejected ?? (await mcpHandler.fetch(request)));
    } catch (error) {
      console.error("Request failed:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("Internal Server Error");
    }
  });

  httpServer.listen(port, host, () => {
    console.log(`MCP test server listening on http://${host}:${port}/mcp`);
  });

  const shutdown = async (): Promise<void> => {
    await mcpHandler.close();
    httpServer.close(() => process.exit(0));
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
