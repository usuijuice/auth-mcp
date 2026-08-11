# auth-mcp

A minimal MCP test server using Streamable HTTP and the latest MCP SDK. It supports the
current `2026-07-28` protocol and stateless clients using the 2025-era protocol from the
same endpoint. It provides two tools:

- `echo` returns the supplied text.
- `add` returns the sum of two numbers.

## Run locally

Requires Node.js 20 or newer and pnpm.

```sh
pnpm install
pnpm build
pnpm start
```

The MCP endpoint is `http://127.0.0.1:3000/mcp`. Set `HOST` or `PORT` to override the defaults.

For example, connect with the MCP Inspector:

```sh
npx @modelcontextprotocol/inspector http://127.0.0.1:3000/mcp
```
