import { describe, expect, it, vi } from "vitest";
import {
  createGoogleAuthorizationUrl,
  createPkce,
  exchangeGoogleAuthorizationCode,
  fetchGoogleUser,
  googleUserId,
} from "../src/google-auth.js";

describe("Google OAuth helpers", () => {
  it("builds an authorization request with PKCE and minimal scopes", async () => {
    const pkce = await createPkce();
    const url = createGoogleAuthorizationUrl({
      clientId: "google-client",
      codeChallenge: pkce.challenge,
      redirectUri: "https://mcp.test/callback",
      state: "state-token",
    });

    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toBe("openid profile");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-token");
  });

  it("exchanges the code and reads the Google user without returning Google tokens", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ access_token: "google-access-token" }))
      .mockResolvedValueOnce(Response.json({ sub: "google-subject", name: "Ada Lovelace" }));

    const accessToken = await exchangeGoogleAuthorizationCode(
      {
        clientId: "google-client",
        clientSecret: "google-secret",
        code: "google-code",
        codeVerifier: "verifier",
        redirectUri: "https://mcp.test/callback",
      },
      fetchFn,
    );
    const user = await fetchGoogleUser(accessToken, fetchFn);

    expect(user).toEqual({ subject: "google-subject", name: "Ada Lovelace" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const tokenRequest = fetchFn.mock.calls[0];
    expect(tokenRequest?.[0]).toBe("https://oauth2.googleapis.com/token");
    expect(String(tokenRequest?.[1]?.body)).toContain("code_verifier=verifier");
    expect(await googleUserId(user.subject)).toMatch(/^google-[A-Za-z0-9_-]+$/);
  });

  it("rejects incomplete Google responses", async () => {
    await expect(
      exchangeGoogleAuthorizationCode(
        {
          clientId: "google-client",
          clientSecret: "google-secret",
          code: "bad-code",
          codeVerifier: "verifier",
          redirectUri: "https://mcp.test/callback",
        },
        vi.fn<typeof fetch>().mockResolvedValue(Response.json({}, { status: 400 })),
      ),
    ).rejects.toThrow("Google rejected the authorization code");

    await expect(
      fetchGoogleUser(
        "token",
        vi.fn<typeof fetch>().mockResolvedValue(Response.json({ sub: "subject" })),
      ),
    ).rejects.toThrow("incomplete user information");
  });
});
