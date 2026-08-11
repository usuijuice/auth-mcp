# Google user MCP

Google OAuth でユーザーを認証し、認証したユーザーの表示名を返す Streamable HTTP MCP
サーバーです。提供するツールは `get_current_user` だけです。

## Google OAuth の準備

1. Google Cloud Console で OAuth 同意画面を設定します。
2. OAuth 2.0 クライアントを作成し、使用する MCP クライアントのリダイレクト URI を登録します。
3. 同じクライアント ID を MCP クライアントと、このサーバーの `GOOGLE_CLIENT_ID` に設定します。
4. MCP クライアントには必要に応じてクライアントシークレットも設定します。サーバー側には不要です。

Google は Dynamic Client Registration を提供しないため、MCP クライアントには事前登録した
クライアント ID を設定してください。認証では `openid profile` スコープを使用します。

## 設定

`.env.example` を `.env` にコピーします。プロジェクト直下の `.env` は起動時に自動で読み込まれ、
すでに設定されている環境変数は上書きしません。

```sh
cp .env.example .env
```

| 環境変数           | 必須         | 説明                                                 |
| ------------------ | ------------ | ---------------------------------------------------- |
| `GOOGLE_CLIENT_ID` | はい         | Google Cloud で作成した OAuth 2.0 クライアント ID。  |
| `MCP_SERVER_URL`   | 本番では推奨 | 公開 MCP URL。既定値は `http://127.0.0.1:3000/mcp`。 |
| `HOST` / `PORT`    | いいえ       | listen 先。既定値は `127.0.0.1:3000`。               |

本番の `MCP_SERVER_URL` には HTTPS URL を指定してください。

## 実行

Node.js 20.12 以上と pnpm が必要です。

```sh
pnpm install
pnpm build
pnpm start
```

MCP エンドポイントは `MCP_SERVER_URL` です。アクセストークンの OAuth クライアント、期限、
スコープを Google の token info endpoint で検証し、Google OpenID Connect の userinfo endpoint
から認証ユーザーの表示名を取得します。
