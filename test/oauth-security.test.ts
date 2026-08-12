import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  consumeGoogleState,
  createCsrfProtection,
  escapeHtml,
  storeGoogleState,
  validateCsrfProtection,
} from "../src/oauth-security.js";

describe("OAuth browser state", () => {
  it("validates CSRF tokens once they are bound to a cookie", async () => {
    const url = new URL("https://mcp.test/authorize");
    const csrf = createCsrfProtection(url);
    const cookie = csrf.cookie.split(";", 1)[0];
    const form = new FormData();
    form.set("csrf_token", csrf.token);

    const result = await validateCsrfProtection(
      new Request(url, { method: "POST", headers: { cookie } }),
      form,
    );
    expect(result.clearCookie).toContain("Max-Age=0");

    await expect(
      validateCsrfProtection(new Request(url, { method: "POST" }), form),
    ).rejects.toThrow("Invalid CSRF token");
  });

  it("stores state briefly, binds it to the browser, and consumes it once", async () => {
    const requestUrl = new URL("https://mcp.test/authorize");
    const stored = await storeGoogleState(requestUrl, env.OAUTH_KV, {
      codeVerifier: "verifier",
      oauthRequest: {
        responseType: "code",
        clientId: "https://client.test/client.json",
        redirectUri: "https://client.test/callback",
        scope: ["profile"],
        state: "client-state",
      },
    });
    const cookie = stored.cookie.split(";", 1)[0];
    const callback = new Request(`https://mcp.test/callback?state=${stored.state}`, {
      headers: { cookie },
    });

    const consumed = await consumeGoogleState(callback, env.OAUTH_KV, stored.state);
    expect(consumed.value.codeVerifier).toBe("verifier");
    expect(consumed.clearCookie).toContain("Max-Age=0");
    await expect(consumeGoogleState(callback, env.OAUTH_KV, stored.state)).rejects.toThrow(
      "invalid or expired",
    );
  });

  it("escapes all client-controlled HTML", () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#039;x&#039;)&quot;&gt;",
    );
  });
});
