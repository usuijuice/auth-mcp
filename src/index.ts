#!/usr/bin/env node

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import {
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  McpServer,
  oauthMetadataResponse,
  originValidationResponse,
  requireBearerAuth,
  type AuthMetadataOptions,
  type McpRequestContext,
  type OAuthMetadata,
} from "@modelcontextprotocol/server";
import { createGoogleTokenVerifier, getGoogleUserName } from "./google-auth.js";

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
if (serverUrl.search || serverUrl.hash) {
  throw new Error("MCP_SERVER_URL must not contain a query string or fragment");
}

const scopes = ["openid", "profile"];
const oauthMetadata: OAuthMetadata = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "refresh_token"],
  token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
  code_challenge_methods_supported: ["S256"],
  scopes_supported: scopes,
};
const authMetadataOptions: AuthMetadataOptions = {
  oauthMetadata,
  resourceServerUrl: serverUrl,
  resourceName: "Google user MCP",
  scopesSupported: scopes,
};
const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(serverUrl);
const requireAuth = requireBearerAuth({
  verifier: createGoogleTokenVerifier(clientId),
  requiredScopes: scopes,
  resourceMetadataUrl,
});

function createMcpServer(context: McpRequestContext): McpServer {
  const server = new McpServer({ name: "google-user-mcp", version: "1.0.0" });
  server.registerTool(
    "get_current_user",
    {
      description: "Get the display name of the user authenticated with Google.",
    },
    async () => {
      const name = getGoogleUserName(context.authInfo);
      return {
        content: [{ type: "text", text: name }],
        structuredContent: { name },
      };
    },
  );
  return server;
}

const mcpHandler = createMcpHandler(createMcpServer, {
  legacy: "stateless",
  onerror: (error) => console.error("MCP error:", error),
});
const allowedHosts = [...new Set([serverUrl.hostname, ...localhostAllowedHostnames()])];
const allowedOrigins = [...new Set([serverUrl.hostname, ...localhostAllowedOrigins()])];

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

async function handleRequest(request: Request): Promise<Response> {
  const rejected =
    hostHeaderValidationResponse(request, allowedHosts) ??
    originValidationResponse(request, allowedOrigins);
  if (rejected) return rejected;

  const metadata = oauthMetadataResponse(request, authMetadataOptions);
  if (metadata) return metadata;

  if (new URL(request.url).pathname !== serverUrl.pathname) {
    return new Response("Not Found", { status: 404 });
  }

  const auth = await requireAuth(request);
  if (auth instanceof Response) return auth;
  return mcpHandler.fetch(request, { authInfo: auth });
}

const httpServer = createServer(async (req, res) => {
  try {
    await sendWebResponse(res, await handleRequest(toWebRequest(req)));
  } catch (error) {
    console.error("Request failed:", error);
    if (!res.headersSent) res.writeHead(500);
    res.end("Internal Server Error");
  }
});

httpServer.listen(port, host, () => {
  console.log(`Google user MCP listening on ${serverUrl}`);
  console.log(`OAuth metadata available at ${resourceMetadataUrl}`);
});

async function shutdown(): Promise<void> {
  await mcpHandler.close();
  httpServer.close(() => process.exit(0));
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
