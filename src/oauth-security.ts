import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { googleAuthorizationOrigin, randomToken, stateBinding } from "./google-auth.js";

const stateTtlSeconds = 600;
const stateKeyPrefix = "app:google-state:";

interface StoredGoogleState {
  codeVerifier: string;
  oauthRequest: AuthRequest;
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function cookieName(kind: "csrf" | "state", token: string, requestUrl: URL): string {
  const prefix = isLocalHostname(requestUrl.hostname) ? "" : "__Host-";
  return `${prefix}auth-mcp-${kind}-${token.slice(0, 16)}`;
}

function serializeCookie(name: string, value: string, requestUrl: URL, maxAge: number): string {
  const secure = isLocalHostname(requestUrl.hostname) ? "" : "; Secure";
  return `${name}=${value}; HttpOnly${secure}; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

function getCookie(request: Request, name: string): string | undefined {
  for (const part of request.headers.get("cookie")?.split(";") ?? []) {
    const [candidate, ...value] = part.trim().split("=");
    if (candidate === name) return value.join("=");
  }
  return undefined;
}

async function secureEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([stateBinding(left), stateBinding(right)]);
  if (leftHash.length !== rightHash.length) return false;
  let difference = 0;
  for (let index = 0; index < leftHash.length; index++) {
    difference |= leftHash.charCodeAt(index) ^ rightHash.charCodeAt(index);
  }
  return difference === 0;
}

export function createCsrfProtection(requestUrl: URL): { cookie: string; token: string } {
  const token = randomToken();
  const name = cookieName("csrf", token, requestUrl);
  return { token, cookie: serializeCookie(name, token, requestUrl, stateTtlSeconds) };
}

export async function validateCsrfProtection(
  request: Request,
  formData: FormData,
): Promise<{ clearCookie: string }> {
  const token = formData.get("csrf_token");
  if (typeof token !== "string" || !token) throw new Error("Missing CSRF token");
  const url = new URL(request.url);
  const name = cookieName("csrf", token, url);
  const cookieToken = getCookie(request, name);
  if (!cookieToken || !(await secureEqual(token, cookieToken))) {
    throw new Error("Invalid CSRF token");
  }
  return { clearCookie: serializeCookie(name, "", url, 0) };
}

export async function storeGoogleState(
  requestUrl: URL,
  kv: KVNamespace,
  value: StoredGoogleState,
): Promise<{ cookie: string; state: string }> {
  const state = randomToken();
  await kv.put(`${stateKeyPrefix}${state}`, JSON.stringify(value), {
    expirationTtl: stateTtlSeconds,
  });
  const name = cookieName("state", state, requestUrl);
  const cookie = serializeCookie(name, await stateBinding(state), requestUrl, stateTtlSeconds);
  return { state, cookie };
}

export async function consumeGoogleState(
  request: Request,
  kv: KVNamespace,
  state: string,
): Promise<{ clearCookie: string; value: StoredGoogleState }> {
  const url = new URL(request.url);
  const name = cookieName("state", state, url);
  const expectedBinding = getCookie(request, name);
  if (!expectedBinding || !(await secureEqual(expectedBinding, await stateBinding(state)))) {
    throw new Error("Invalid OAuth state binding");
  }

  const key = `${stateKeyPrefix}${state}`;
  const stored = await kv.get(key);
  if (!stored) throw new Error("OAuth state is invalid or expired");
  await kv.delete(key);

  let value: StoredGoogleState;
  try {
    value = JSON.parse(stored) as StoredGoogleState;
  } catch {
    throw new Error("Stored OAuth state is invalid");
  }
  return { value, clearCookie: serializeCookie(name, "", url, 0) };
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function htmlResponse(
  body: string,
  status = 200,
  cookies: string[] = [],
  formAction = "'none'",
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
    "content-type": "text/html; charset=utf-8",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(body, { status, headers });
}

function page(title: string, content: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(34rem, calc(100% - 2rem)); border: 1px solid GrayText; border-radius: 1rem; padding: 1.5rem; box-sizing: border-box; }
    h1 { margin-top: 0; font-size: 1.4rem; }
    dl { display: grid; gap: .4rem; }
    dt { font-weight: 700; margin-top: .5rem; }
    dd { margin: 0; overflow-wrap: anywhere; }
    .actions { display: flex; gap: .75rem; margin-top: 1.5rem; }
    button { padding: .65rem 1rem; border-radius: .5rem; border: 1px solid GrayText; cursor: pointer; }
    button[value="allow"] { background: #1769e0; color: white; border-color: #1769e0; }
  </style>
</head>
<body><main>${content}</main></body>
</html>`;
}

export function consentResponse(
  request: Request,
  oauthRequest: AuthRequest,
  clientName: string,
): Response {
  const csrf = createCsrfProtection(new URL(request.url));
  const redirectUrl = new URL(oauthRequest.redirectUri);
  const redirectFormAction =
    redirectUrl.protocol === "http:" || redirectUrl.protocol === "https:"
      ? redirectUrl.origin
      : redirectUrl.protocol;
  const scopes = oauthRequest.scope.map(escapeHtml).join(", ") || "(none)";
  const content = `<h1>MCP接続を許可しますか？</h1>
<p>次のクライアントがGoogleプロフィールの表示名へのアクセスを求めています。</p>
<dl>
  <dt>クライアント</dt><dd>${escapeHtml(clientName)}</dd>
  <dt>Client ID</dt><dd>${escapeHtml(oauthRequest.clientId)}</dd>
  <dt>Redirect URI</dt><dd>${escapeHtml(oauthRequest.redirectUri)}</dd>
  <dt>Scope</dt><dd>${scopes}</dd>
</dl>
<form method="post" action="${escapeHtml(request.url)}">
  <input type="hidden" name="csrf_token" value="${escapeHtml(csrf.token)}">
  <div class="actions">
    <button type="submit" name="decision" value="allow">許可してGoogleへ進む</button>
    <button type="submit" name="decision" value="deny">拒否</button>
  </div>
</form>`;
  const formAction = `'self' ${googleAuthorizationOrigin} ${redirectFormAction}`;
  return htmlResponse(page("MCP接続の確認", content), 200, [csrf.cookie], formAction);
}

export function localErrorResponse(message: string, status = 400): Response {
  return htmlResponse(
    page("認証エラー", `<h1>認証を完了できませんでした</h1><p>${escapeHtml(message)}</p>`),
    status,
  );
}

export function responseWithCookies(response: Response, cookies: string[]): Response {
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
