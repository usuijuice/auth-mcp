export const googleAuthorizationOrigin = "https://accounts.google.com";
const googleAuthorizationEndpoint = `${googleAuthorizationOrigin}/o/oauth2/v2/auth`;
const googleTokenEndpoint = "https://oauth2.googleapis.com/token";
const googleUserInfoEndpoint = "https://openidconnect.googleapis.com/v1/userinfo";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export function randomToken(byteLength = 32): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function createPkce(): Promise<{ challenge: string; verifier: string }> {
  const verifier = randomToken(64);
  return { verifier, challenge: base64Url(await sha256(verifier)) };
}

export function createGoogleAuthorizationUrl(options: {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  state: string;
}): URL {
  const url = new URL(googleAuthorizationEndpoint);
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile");
  url.searchParams.set("state", options.state);
  url.searchParams.set("code_challenge", options.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

async function readJson(
  response: Response,
  errorMessage: string,
): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(errorMessage);
  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== "object") throw new Error(errorMessage);
    return body as Record<string, unknown>;
  } catch {
    throw new Error(errorMessage);
  }
}

export async function exchangeGoogleAuthorizationCode(
  options: {
    clientId: string;
    clientSecret: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
  },
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  let response: Response;
  try {
    response = await fetchFn(googleTokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        code: options.code,
        code_verifier: options.codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: options.redirectUri,
      }),
    });
  } catch {
    throw new Error("Google token exchange is unavailable");
  }

  const body = await readJson(response, "Google rejected the authorization code");
  if (typeof body.access_token !== "string" || !body.access_token) {
    throw new Error("Google returned an invalid token response");
  }
  return body.access_token;
}

export async function fetchGoogleUser(accessToken: string, fetchFn: typeof fetch = fetch) {
  let response: Response;
  try {
    response = await fetchFn(googleUserInfoEndpoint, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new Error("Google user information is unavailable");
  }

  const body = await readJson(response, "Google user information is unavailable");
  if (typeof body.sub !== "string" || !body.sub || typeof body.name !== "string" || !body.name) {
    throw new Error("Google returned incomplete user information");
  }
  return { subject: body.sub, name: body.name };
}

export async function googleUserId(subject: string): Promise<string> {
  return `google-${base64Url(await sha256(`google:${subject}`))}`;
}

export async function stateBinding(state: string): Promise<string> {
  return base64Url(await sha256(state));
}
