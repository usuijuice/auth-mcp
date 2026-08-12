import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/worker.ts",
      miniflare: {
        compatibilityDate: "2026-08-04",
        compatibilityFlags: ["global_fetch_strictly_public"],
        kvNamespaces: ["OAUTH_KV"],
        outboundService: async (request) => {
          const url = new URL(request.url);
          if (url.href === "https://client.test/client.json") {
            return Response.json(
              {
                client_id: url.href,
                client_name: "Integration client",
                redirect_uris: ["https://client.test/callback"],
                grant_types: ["authorization_code", "refresh_token"],
                response_types: ["code"],
                token_endpoint_auth_method: "none",
              },
              { headers: { "cache-control": "max-age=60" } },
            );
          }
          if (url.href === "https://invalid-client.test/client.json") {
            return Response.json({
              client_id: "https://someone-else.test/client.json",
              client_name: "Invalid client",
              redirect_uris: ["https://client.test/callback"],
              token_endpoint_auth_method: "none",
            });
          }
          if (url.href === "https://oauth2.googleapis.com/token") {
            return Response.json({ access_token: "upstream-google-token" });
          }
          if (url.href === "https://openidconnect.googleapis.com/v1/userinfo") {
            return Response.json({ sub: "google-user-123", name: "Grace Hopper" });
          }
          return new Response("Not Found", { status: 404 });
        },
        bindings: {
          GOOGLE_CLIENT_ID: "test.apps.googleusercontent.com",
          GOOGLE_CLIENT_SECRET: "test-google-secret",
          MCP_SERVER_URL: "https://mcp.test/mcp",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
