import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createPkce } from "../src/google-auth.js";

const serverUrl = new URL("https://mcp.test/mcp");

function cookiePair(setCookie: string, marker: string): string {
  const match = new RegExp(`(?:^|, )([^,;]*${marker}[^,;]*=[^,;]*)`).exec(setCookie);
  if (!match?.[1]) throw new Error(`Missing ${marker} cookie`);
  return match[1];
}

function csrfFromHtml(html: string): string {
  const match = /name="csrf_token" value="([^"]+)"/.exec(html);
  if (!match?.[1]) throw new Error("Missing CSRF token");
  return match[1];
}

describe("OAuth discovery", () => {
  it("advertises the protected MCP resource and CIMD without DCR", async () => {
    const protectedResource = await exports.default.fetch(
      "https://mcp.test/.well-known/oauth-protected-resource/mcp",
    );
    expect(protectedResource.status).toBe(200);
    expect(await protectedResource.json()).toMatchObject({
      resource: serverUrl.href,
      authorization_servers: [serverUrl.origin],
      scopes_supported: ["profile"],
      bearer_methods_supported: ["header"],
    });

    const authorizationServer = await exports.default.fetch(
      "https://mcp.test/.well-known/oauth-authorization-server",
    );
    expect(authorizationServer.status).toBe(200);
    const metadata = (await authorizationServer.json()) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      issuer: serverUrl.origin,
      authorization_endpoint: "https://mcp.test/authorize",
      token_endpoint: "https://mcp.test/token",
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ["S256"],
      scopes_supported: ["profile"],
    });
    expect(metadata).not.toHaveProperty("registration_endpoint");
  });

  it("challenges unauthenticated MCP requests with resource metadata", async () => {
    const response = await exports.default.fetch(serverUrl.href, { method: "POST" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://mcp.test/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("rejects client metadata whose client_id does not match its document URL", async () => {
    const authorize = new URL("https://mcp.test/authorize");
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", "https://invalid-client.test/client.json");
    authorize.searchParams.set("redirect_uri", "https://client.test/callback");
    authorize.searchParams.set("scope", "profile");
    authorize.searchParams.set("state", "invalid-client-state");
    authorize.searchParams.set("resource", serverUrl.href);
    authorize.searchParams.set("code_challenge", "valid-looking-s256-challenge");
    authorize.searchParams.set("code_challenge_method", "S256");

    const response = await exports.default.fetch(authorize, { redirect: "manual" });
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("OAuth client metadata could not be verified");
  });
});

describe("complete authorization flow", () => {
  it("issues a Worker token and returns only the Google display name from the tool", async () => {
    const clientId = "https://client.test/client.json";
    const redirectUri = "https://client.test/callback";
    const downstreamPkce = await createPkce();
    const authorize = new URL("https://mcp.test/authorize");
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("client_id", clientId);
    authorize.searchParams.set("redirect_uri", redirectUri);
    authorize.searchParams.set("scope", "profile");
    authorize.searchParams.set("state", "downstream-state");
    authorize.searchParams.set("resource", serverUrl.href);
    authorize.searchParams.set("code_challenge", downstreamPkce.challenge);
    authorize.searchParams.set("code_challenge_method", "S256");

    const consent = await exports.default.fetch(authorize);
    expect(consent.status).toBe(200);
    const consentHtml = await consent.text();
    expect(consentHtml).toContain("Integration client");
    expect(consent.headers.get("content-security-policy")).toContain(
      "form-action 'self' https://accounts.google.com",
    );
    expect(consent.headers.get("content-security-policy")).toContain("https://client.test");
    expect(consent.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const csrf = csrfFromHtml(consentHtml);
    const csrfCookie = cookiePair(consent.headers.get("set-cookie") || "", "csrf");

    const approval = await exports.default.fetch(authorize, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: csrfCookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ csrf_token: csrf, decision: "allow" }),
    });
    expect(approval.status).toBe(302);
    const googleAuthorization = new URL(approval.headers.get("location")!);
    expect(googleAuthorization.origin).toBe("https://accounts.google.com");
    const googleState = googleAuthorization.searchParams.get("state")!;
    const stateCookie = cookiePair(approval.headers.get("set-cookie") || "", "state");

    const callback = await exports.default.fetch(
      `https://mcp.test/callback?state=${encodeURIComponent(googleState)}&code=google-code`,
      { headers: { cookie: stateCookie }, redirect: "manual" },
    );
    expect(callback.status).toBe(302);
    const clientRedirect = new URL(callback.headers.get("location")!);
    expect(clientRedirect.origin).toBe("https://client.test");
    expect(clientRedirect.searchParams.get("state")).toBe("downstream-state");
    const authorizationCode = clientRedirect.searchParams.get("code")!;

    const tokenResponse = await exports.default.fetch("https://mcp.test/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: authorizationCode,
        code_verifier: downstreamPkce.verifier,
        redirect_uri: redirectUri,
        resource: serverUrl.href,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token?: string;
      scope: string;
    };
    expect(tokens.scope).toBe("profile");
    expect(tokens.refresh_token).toBeTypeOf("string");
    expect(JSON.stringify(tokens)).not.toContain("upstream-google-token");

    const toolResponse = await exports.default.fetch(serverUrl.href, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tokens.access_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_current_user", arguments: {} },
      }),
    });
    const toolResponseText = await toolResponse.text();
    expect(toolResponse.status, toolResponseText).toBe(200);
    const dataLine = toolResponseText.split("\n").find((line) => line.startsWith("data: "));
    expect(dataLine).toBeTypeOf("string");
    const toolResult = JSON.parse(dataLine!.slice("data: ".length)) as {
      result?: { content?: Array<{ text?: string }> };
    };
    expect(toolResult.result?.content?.[0]?.text).toBe("Grace Hopper");

    const replay = await exports.default.fetch(
      `https://mcp.test/callback?state=${encodeURIComponent(googleState)}&code=google-code`,
      { headers: { cookie: stateCookie } },
    );
    expect(replay.status).toBe(400);
  });
});
