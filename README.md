# Google user MCP

Cloudflare Workers上で動作する、Googleログイン対応のStreamable HTTP MCPサーバーです。
`get_current_user` ツールは、ログインしたGoogleユーザーの表示名を返します。

このWorkerはMCPリソースサーバーとOAuth認可サーバーを兼ねます。MCPクライアントの識別には
[Client ID Metadata Document（CIMD）](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/)
を使い、Google OAuthはWorkerとGoogleの間だけで行います。

```text
MCP client -- CIMD / OAuth + PKCE --> Worker -- OAuth + PKCE --> Google
                                      |
                                      +-- Worker access token --> /mcp
```

## 要件

- Node.js 20.12以上
- pnpm
- Cloudflareアカウント
- Google CloudのOAuth 2.0クライアント（種類: ウェブ アプリケーション）
- 公開環境ではHTTPSのWorker URL

## Google OAuthの準備

Google Cloud ConsoleでOAuth同意画面とOAuth 2.0クライアントを作成します。承認済みのリダイレクト
URIは、Workerのオリジンに `/callback` を付けたURLです。

```text
https://auth-mcp.example.workers.dev/callback
```

ローカル開発用クライアントでは、次のURIを追加します。

```text
http://localhost:8787/callback
```

Googleには `openid profile` だけを要求します。取得したGoogleアクセストークンはWorkerのKV、
OAuth grant、ログ、MCPクライアントのいずれにも保存・転送しません。WorkerにはGoogleのsubjectを
ハッシュしたユーザーIDと表示名だけが残ります。

## ローカル開発

依存関係をインストールし、開発用設定を作成します。

```sh
pnpm install
cp .dev.vars.example .dev.vars
```

`.dev.vars` を実際のGoogle OAuthクライアント情報に書き換えます。

| 設定                   | 説明                                              |
| ---------------------- | ------------------------------------------------- |
| `GOOGLE_CLIENT_ID`     | Google OAuth 2.0クライアントID                    |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0クライアントシークレット          |
| `MCP_SERVER_URL`       | MCP URL。ローカルでは `http://localhost:8787/mcp` |

Workerを起動します。

```sh
pnpm worker:dev
```

OAuthのstateは `OAUTH_KV` に10分間だけ保存され、一度使うと削除されます。ローカルではWranglerが
KVをエミュレートします。

## Cloudflare Workersへのデプロイ

最初にWranglerへログインします。

```sh
pnpm exec wrangler login
```

本番値をWorkerのsecretとして登録します。`MCP_SERVER_URL` は公開される正確なHTTPS URLで、パスは
必ず `/mcp`、クエリとフラグメントはなしにします。

```sh
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put MCP_SERVER_URL
```

デプロイします。

```sh
pnpm worker:deploy
```

`wrangler.jsonc` の `OAUTH_KV` は自動プロビジョニング対象です。初回デプロイ時にCloudflareがKV
namespaceを作成し、割り当てたIDを設定へ追加します。設定差分が生じた場合は内容を確認して
コミットしてください。最後に、デプロイ先の `/callback` がGoogle Cloud Consoleへ登録済みである
ことを確認します。

## MCPクライアントのCIMD

接続するMCPクライアントは、公開HTTPS URLにクライアントメタデータJSONを配置し、そのURL自体を
`client_id` として使用する必要があります。たとえば
`https://client.example/oauth/client.json` の内容は次のようになります。

```json
{
  "client_id": "https://client.example/oauth/client.json",
  "client_name": "Example MCP Client",
  "redirect_uris": ["https://client.example/oauth/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

WorkerはCIMD URLを取得し、文書内の `client_id` が取得元URLと一致すること、redirect URIなどの
メタデータが妥当なことを検証します。下流OAuthでは次の条件を使用します。

- Authorization Code Flow + PKCE（`S256`のみ）
- scope: `profile`
- MCP resource: `MCP_SERVER_URL` の値
- 接続ごとにWorker上の同意画面を表示

OAuth Authorization Server Metadataは
`/.well-known/oauth-authorization-server`、Protected Resource Metadataは
`/.well-known/oauth-protected-resource/mcp` で公開されます。

## Dynamic Client Registrationについて

Dynamic Client Registration（DCR）は提供しません。Authorization Server Metadataにも
`registration_endpoint` は含まれません。CIMDに対応していないクライアントや、HTTPSで公開された
メタデータ文書を用意できないクライアントは接続できません。

## 旧バージョンからの移行

これは破壊的変更です。旧バージョンはMCPクライアントが取得したGoogleアクセストークンを直接
`/mcp` へ渡していましたが、現在はWorkerが発行したアクセストークンだけを受け付けます。

- 既存のGoogleアクセストークンはMCP認証には使えません。
- MCPクライアント側のGoogle client ID / secret設定は削除してください。
- MCPクライアントをCIMD対応にし、公開メタデータURLをclient IDとして設定してください。
- Node.jsサーバーと `pnpm start` は廃止され、Cloudflare Workersのみをサポートします。

## 開発用コマンド

```sh
pnpm test          # OAuth、CIMD、state/CSRF、MCP統合テスト
pnpm typecheck     # TypeScriptチェック
pnpm lint          # lint
pnpm fmt:check     # formatチェック
pnpm worker:check  # Workerのdry-run build
pnpm check         # 上記をまとめて実行
```
