import { WorkerEntrypoint } from "cloudflare:workers";
import { OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import {
  hostHeaderValidationResponse,
  originValidationResponse,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { authHandler, type OAuthEnv } from "./auth-handler.js";
import { handleMcpRequest, requiredScopes } from "./mcp-app.js";

interface AuthProps {
  displayName: string;
}

function bearerToken(request: Request): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") || "");
  return match?.[1];
}

export class McpApiHandler extends WorkerEntrypoint<OAuthEnv, AuthProps> {
  async fetch(request: Request): Promise<Response> {
    const serverUrl = validatedServerUrl(this.env);
    if (!request.headers.has("host")) {
      const headers = new Headers(request.headers);
      headers.set("host", serverUrl.host);
      request = new Request(request, { headers });
    }
    const rejected =
      hostHeaderValidationResponse(request, [serverUrl.hostname]) ??
      originValidationResponse(request, [serverUrl.origin]);
    if (rejected) return rejected;

    const token = bearerToken(request);
    if (!token) return new Response("Unauthorized", { status: 401 });
    const summary = await this.env.OAUTH_PROVIDER.unwrapToken<AuthProps>(token);
    if (!summary) return new Response("Unauthorized", { status: 401 });
    if (requiredScopes().some((scope) => !summary.scope.includes(scope))) {
      return new Response("Insufficient Scope", { status: 403 });
    }
    const displayName = summary.grant.props.displayName;
    if (typeof displayName !== "string" || !displayName) {
      return new Response("Unauthorized", { status: 401 });
    }

    const authInfo: AuthInfo = {
      token,
      clientId: summary.grant.clientId,
      scopes: summary.scope,
      expiresAt: summary.expiresAt,
      extra: { name: displayName },
    };
    return handleMcpRequest(request, authInfo);
  }
}

function requiredValue(value: string | undefined, name: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`Missing required Worker secret: ${name}`);
  return result;
}

function validatedServerUrl(env: OAuthEnv): URL {
  const serverUrl = new URL(requiredValue(env.MCP_SERVER_URL, "MCP_SERVER_URL"));
  if (serverUrl.pathname !== "/mcp" || serverUrl.search || serverUrl.hash) {
    throw new Error("MCP_SERVER_URL must use the /mcp path without a query string or fragment");
  }
  if (
    serverUrl.protocol !== "https:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(serverUrl.hostname)
  ) {
    throw new Error("MCP_SERVER_URL must use HTTPS outside localhost");
  }
  return serverUrl;
}

function validateEnvironment(env: OAuthEnv): URL {
  requiredValue(env.GOOGLE_CLIENT_ID, "GOOGLE_CLIENT_ID");
  requiredValue(env.GOOGLE_CLIENT_SECRET, "GOOGLE_CLIENT_SECRET");
  if (!env.OAUTH_KV) throw new Error("Missing required Worker binding: OAUTH_KV");
  return validatedServerUrl(env);
}

let provider: OAuthProvider<OAuthEnv> | undefined;
let providerKey: string | undefined;

function createProviderOptions(serverUrl: URL): OAuthProviderOptions<OAuthEnv> {
  const issuer = serverUrl.origin;
  return {
    apiRoute: serverUrl.href,
    apiHandler: McpApiHandler,
    defaultHandler: authHandler,
    authorizeEndpoint: new URL("/authorize", issuer).href,
    tokenEndpoint: new URL("/token", issuer).href,
    scopesSupported: requiredScopes(),
    clientIdMetadataDocumentEnabled: true,
    allowImplicitFlow: false,
    allowPlainPKCE: false,
    resourceMetadata: {
      resource: serverUrl.href,
      authorization_servers: [issuer],
      scopes_supported: requiredScopes(),
      bearer_methods_supported: ["header"],
      resource_name: "Google user MCP",
    },
    onError(error) {
      console.error("OAuth provider error:", {
        code: error.code,
        status: error.status,
        internal: error.internal,
      });
    },
  };
}

function getProvider(serverUrl: URL): OAuthProvider<OAuthEnv> {
  if (provider && providerKey === serverUrl.href) return provider;

  provider = new OAuthProvider<OAuthEnv>(createProviderOptions(serverUrl));
  providerKey = serverUrl.href;
  return provider;
}

export default {
  async fetch(request: Request, env: OAuthEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      const serverUrl = validateEnvironment(env);
      if (new URL(request.url).origin !== serverUrl.origin) {
        return new Response("Misdirected Request", { status: 421 });
      }
      return await getProvider(serverUrl).fetch(request, env, ctx);
    } catch (error) {
      console.error("Worker configuration error:", error);
      return new Response("Worker is not configured", { status: 500 });
    }
  },
} satisfies ExportedHandler<OAuthEnv>;
