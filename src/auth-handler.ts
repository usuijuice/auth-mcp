import {
  AuthorizationError,
  CimdFetchError,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import {
  createGoogleAuthorizationUrl,
  createPkce,
  exchangeGoogleAuthorizationCode,
  fetchGoogleUser,
  googleUserId,
} from "./google-auth.js";
import { requiredScopes } from "./mcp-app.js";
import {
  consentResponse,
  consumeGoogleState,
  localErrorResponse,
  responseWithCookies,
  storeGoogleState,
  validateCsrfProtection,
} from "./oauth-security.js";

export interface OAuthEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

function callbackUrl(env: OAuthEnv): URL {
  return new URL("/callback", env.MCP_SERVER_URL);
}

function authorizationErrorResponse(error: AuthorizationError): Response {
  if (!error.redirectUri) return localErrorResponse(error.description, 400);
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect, 302);
}

function requestErrorResponse(
  request: AuthRequest,
  code: "access_denied" | "server_error" | "temporarily_unavailable",
  description: string,
): Response {
  return authorizationErrorResponse(
    new AuthorizationError(code, {
      description,
      redirectUri: request.redirectUri,
      state: request.state,
      issuer: request.issuer,
    }),
  );
}

function validateScopes(request: AuthRequest): void {
  const required = requiredScopes();
  if (required.some((scope) => !request.scope.includes(scope))) {
    throw new AuthorizationError("invalid_scope", {
      description: `Required scope: ${required.join(" ")}`,
      redirectUri: request.redirectUri,
      state: request.state,
      issuer: request.issuer,
    });
  }
}

async function parseRequest(request: Request, env: OAuthEnv): Promise<AuthRequest> {
  const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  validateScopes(oauthRequest);
  return oauthRequest;
}

async function handleAuthorize(request: Request, env: OAuthEnv): Promise<Response> {
  if (request.method === "GET") {
    const oauthRequest = await parseRequest(request, env);
    const client = await env.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
    if (!client) throw new Error("Unknown OAuth client");
    return consentResponse(request, oauthRequest, client.clientName || "Unknown MCP client");
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const formData = await request.formData();
  const csrf = await validateCsrfProtection(request, formData);
  const oauthRequest = await parseRequest(request, env);
  if (formData.get("decision") !== "allow") {
    return responseWithCookies(
      requestErrorResponse(oauthRequest, "access_denied", "The user denied the request"),
      [csrf.clearCookie],
    );
  }

  const pkce = await createPkce();
  const stored = await storeGoogleState(new URL(request.url), env.OAUTH_KV, {
    oauthRequest,
    codeVerifier: pkce.verifier,
  });
  const redirect = createGoogleAuthorizationUrl({
    clientId: env.GOOGLE_CLIENT_ID,
    codeChallenge: pkce.challenge,
    redirectUri: callbackUrl(env).href,
    state: stored.state,
  });
  return responseWithCookies(Response.redirect(redirect, 302), [csrf.clearCookie, stored.cookie]);
}

async function handleCallback(request: Request, env: OAuthEnv): Promise<Response> {
  if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  if (!state) return localErrorResponse("Google callback is missing state", 400);

  let consumed: Awaited<ReturnType<typeof consumeGoogleState>>;
  try {
    consumed = await consumeGoogleState(request, env.OAUTH_KV, state);
  } catch (error) {
    console.error("Google OAuth state validation failed:", error);
    return localErrorResponse("The login session is invalid or expired", 400);
  }

  const { oauthRequest, codeVerifier } = consumed.value;
  if (url.searchParams.has("error")) {
    return responseWithCookies(
      requestErrorResponse(oauthRequest, "access_denied", "Google login was denied"),
      [consumed.clearCookie],
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return responseWithCookies(
      requestErrorResponse(oauthRequest, "server_error", "Google callback is missing a code"),
      [consumed.clearCookie],
    );
  }

  try {
    const googleToken = await exchangeGoogleAuthorizationCode({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      code,
      codeVerifier,
      redirectUri: callbackUrl(env).href,
    });
    const user = await fetchGoogleUser(googleToken);
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: oauthRequest,
      userId: await googleUserId(user.subject),
      metadata: {},
      scope: requiredScopes(),
      props: { displayName: user.name },
    });
    return responseWithCookies(Response.redirect(redirectTo, 302), [consumed.clearCookie]);
  } catch (error) {
    console.error("Google authentication failed:", error);
    return responseWithCookies(
      requestErrorResponse(
        oauthRequest,
        "temporarily_unavailable",
        "Google authentication could not be completed",
      ),
      [consumed.clearCookie],
    );
  }
}

export const authHandler: ExportedHandler<OAuthEnv> = {
  async fetch(request, env): Promise<Response> {
    try {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/authorize") return await handleAuthorize(request, env);
      if (pathname === "/callback") return await handleCallback(request, env);
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      if (error instanceof AuthorizationError) return authorizationErrorResponse(error);
      if (error instanceof CimdFetchError) {
        console.error("CIMD lookup failed:", error);
        return localErrorResponse("The OAuth client metadata could not be verified", 400);
      }
      console.error("Authorization request failed:", error);
      return localErrorResponse("The authorization request could not be completed", 400);
    }
  },
};
