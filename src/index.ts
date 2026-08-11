#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { createMcpApp } from "./mcp-app.js";

try {
  loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const host = process.env.HOST?.trim() || "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
if (!clientId) throw new Error("Missing required environment variable: GOOGLE_CLIENT_ID");

const serverUrl = new URL(process.env.MCP_SERVER_URL?.trim() || `http://${host}:${port}/mcp`);
const app = createMcpApp(serverUrl, clientId, { allowLocalhost: true });

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

const httpServer = createServer(async (req, res) => {
  try {
    await sendWebResponse(res, await app.fetch(toWebRequest(req)));
  } catch (error) {
    console.error("Request failed:", error);
    if (!res.headersSent) res.writeHead(500);
    res.end("Internal Server Error");
  }
});

httpServer.listen(port, host, () => {
  console.log(`Google user MCP listening on ${serverUrl}`);
  console.log(`OAuth metadata available at ${app.resourceMetadataUrl}`);
});

async function shutdown(): Promise<void> {
  await app.close();
  httpServer.close(() => process.exit(0));
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
