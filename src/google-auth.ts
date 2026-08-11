import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";

const profileScope = "profile";
const googleProfileScope = "https://www.googleapis.com/auth/userinfo.profile";

interface TokenInfo {
  azp?: string;
  exp?: string;
  scope?: string;
  sub?: string;
}

interface UserInfo {
  name?: string;
  sub?: string;
}

function oauthError(code: OAuthErrorCode, message: string): OAuthError {
  return new OAuthError(code, message);
}

async function googleRequest(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw oauthError(OAuthErrorCode.ServerError, "Google authentication is unavailable");
  }

  if (!response.ok) {
    const code = response.status >= 500 ? OAuthErrorCode.ServerError : OAuthErrorCode.InvalidToken;
    throw oauthError(code, "The Google access token is invalid or expired");
  }

  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    throw oauthError(OAuthErrorCode.ServerError, "Google returned an invalid response");
  }
}

export function createGoogleTokenVerifier(clientId: string): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const tokenInfo = (await googleRequest("https://oauth2.googleapis.com/tokeninfo", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ access_token: token }),
      })) as TokenInfo;

      if (tokenInfo.azp !== clientId) {
        throw oauthError(OAuthErrorCode.InvalidToken, "The token belongs to another OAuth client");
      }

      const expiresAt = Number(tokenInfo.exp);
      const scopes = tokenInfo.scope?.split(/\s+/).filter(Boolean) ?? [];
      if (scopes.includes(googleProfileScope)) scopes.push(profileScope);

      if (!Number.isInteger(expiresAt) || !tokenInfo.sub) {
        throw oauthError(OAuthErrorCode.InvalidToken, "The Google access token is incomplete");
      }

      const userInfo = (await googleRequest("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { authorization: `Bearer ${token}` },
      })) as UserInfo;

      if (userInfo.sub !== tokenInfo.sub || !userInfo.name) {
        throw oauthError(OAuthErrorCode.InvalidToken, "Google user information is incomplete");
      }

      return {
        token,
        clientId,
        scopes: [...new Set(scopes)],
        expiresAt,
        extra: { name: userInfo.name },
      };
    },
  };
}

export function getGoogleUserName(authInfo: AuthInfo | undefined): string {
  const name = authInfo?.extra?.name;
  if (typeof name !== "string" || !name) {
    throw new Error("Authenticated Google user information is unavailable");
  }
  return name;
}
