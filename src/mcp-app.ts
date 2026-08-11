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
  type McpHttpHandler,
  type McpRequestContext,
  type OAuthMetadata,
} from "@modelcontextprotocol/server";
import { createGoogleTokenVerifier, getGoogleUserName } from "./google-auth.js";

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

export interface McpApp {
  close(): Promise<void>;
  fetch(request: Request): Promise<Response>;
  resourceMetadataUrl: string;
}

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

export function createMcpApp(
  serverUrl: URL,
  clientId: string,
  options: { allowLocalhost?: boolean } = {},
): McpApp {
  if (serverUrl.search || serverUrl.hash) {
    throw new Error("MCP_SERVER_URL must not contain a query string or fragment");
  }

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
  const mcpHandler: McpHttpHandler = createMcpHandler(createMcpServer, {
    legacy: "stateless",
    onerror: (error) => console.error("MCP error:", error),
  });
  const allowedHosts = [
    ...new Set([
      serverUrl.hostname,
      ...(options.allowLocalhost ? localhostAllowedHostnames() : []),
    ]),
  ];
  const allowedOrigins = [
    ...new Set([serverUrl.origin, ...(options.allowLocalhost ? localhostAllowedOrigins() : [])]),
  ];

  return {
    resourceMetadataUrl,
    close: () => mcpHandler.close(),
    async fetch(request: Request): Promise<Response> {
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
    },
  };
}
