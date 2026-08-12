import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
  type McpRequestContext,
} from "@modelcontextprotocol/server";

function createMcpServer(context: McpRequestContext): McpServer {
  const server = new McpServer({ name: "google-user-mcp", version: "1.0.0" });
  server.registerTool(
    "get_current_user",
    {
      description: "Get the display name of the user authenticated with Google.",
    },
    async () => {
      const name = context.authInfo?.extra?.name;
      if (typeof name !== "string" || !name) throw new Error("Google user name is unavailable");
      return {
        content: [{ type: "text", text: name }],
        structuredContent: { name },
      };
    },
  );
  return server;
}

const mcpHandler = createMcpHandler(createMcpServer, {
  legacy: "stateless",
  onerror: (error) => console.error("MCP error:", error),
});

export function requiredScopes(): string[] {
  return ["profile"];
}

export function handleMcpRequest(request: Request, authInfo: AuthInfo): Promise<Response> {
  return mcpHandler.fetch(request, { authInfo });
}
