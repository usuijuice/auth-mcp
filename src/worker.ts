import { createMcpApp, type McpApp } from "./mcp-app.js";

interface Env {
  GOOGLE_CLIENT_ID?: string;
}

let app: McpApp | undefined;
let appKey: string | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const clientId = env.GOOGLE_CLIENT_ID?.trim();
    if (!clientId) {
      console.error("Missing required Worker secret: GOOGLE_CLIENT_ID");
      return new Response("Worker is not configured", { status: 500 });
    }

    const serverUrl = new URL("/mcp", request.url);
    const key = `${serverUrl.href}\n${clientId}`;
    if (!app || appKey !== key) {
      app = createMcpApp(serverUrl, clientId, {
        allowLocalhost: serverUrl.hostname === "localhost",
      });
      appKey = key;
    }

    return app.fetch(request);
  },
};
