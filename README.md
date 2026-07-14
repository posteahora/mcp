# @posteahora/mcp

MCP server for [PosteAhora](https://posteahora.com) — let AI agents add ideas,
create, schedule, and publish social posts across Instagram, X/Twitter,
LinkedIn, Threads, Facebook (and more) straight from a chat.

It's a thin wrapper over the PosteAhora public REST API: every call is
authenticated with your API key and goes through the same quota, ownership, and
publishing pipeline as the web app.

## Get an API key

1. Open PosteAhora → **Settings → API & integrations**.
2. Create a key and copy it (it's shown once). It looks like `pah_live_…`.

## Install (Claude Code / Cursor / Windsurf)

Add to your MCP client config:

```json
{
  "mcpServers": {
    "posteahora": {
      "command": "npx",
      "args": ["-y", "@posteahora/mcp"],
      "env": {
        "POSTEAHORA_API_KEY": "pah_live_xxxxxxxx",
        "POSTEAHORA_API_URL": "https://api.posteahora.com/functions/v1/api"
      }
    }
  }
}
```

- **Claude Code:** `claude mcp add posteahora -e POSTEAHORA_API_KEY=pah_live_… -e POSTEAHORA_API_URL=https://api.posteahora.com/functions/v1/api -- npx -y @posteahora/mcp`
- **Cursor / Windsurf:** add the JSON above to the MCP settings file.

## Tools

| Tool | What it does |
|------|--------------|
| `list_accounts` | List connected social accounts. **Call first** — you need each `accountId` to post. |
| `list_ideas` / `create_idea` | Read / add backlog ideas (no publishing). |
| `create_post` | Create a draft, or publish now (`status: "published"`). |
| `schedule_post` | Publish at a future time (`scheduledAt`, ISO 8601). |
| `list_posts` / `get_post_status` | Inspect posts and per-platform results. |
| `upload_media` | Upload a local image/video **from the machine running this server**, returns a public URL for `mediaUrls`. Use in local mode. |
| `create_upload_url` | Return a short-lived presigned URL so the **client** uploads a file directly to storage. Use in remote/hosted mode, where the server can't read your local files. |

### Typical flow

1. `list_accounts` → grab the `id` for each platform you want to post to.
2. (optional) get a `publicUrl` for your media:
   - **Local mode:** `upload_media` with an absolute `filePath` → `publicUrl`.
   - **Remote/hosted mode:** `create_upload_url` with `filename`/`sizeBytes` →
     `uploadUrl` + `publicUrl`; then `HTTP PUT` the raw bytes to `uploadUrl` with
     the matching `Content-Type` header
     (e.g. `curl -T ./slide.jpg "<uploadUrl>" -H 'Content-Type: image/jpeg'`).
     This works for any size, including video, and is required for TikTok photos
     (they must be served from our verified `cdn.posteahora.com` domain).
3. `create_post` with `accountMappings: [{ platform, accountId }]`, `mediaUrls`,
   and `status: "published"` (or `schedule_post` with `scheduledAt`).

## Remote / hosted mode (experimental)

`npm run start:http` starts a stateless Streamable HTTP server on `/mcp`
(`PORT`, default 8787). The caller's `Authorization: Bearer pah_…` header is used
as the API key (falls back to `POSTEAHORA_API_KEY`). Put OAuth in front for a
production multi-tenant connector.

## Development

```bash
npm install
npm run build
POSTEAHORA_API_KEY=pah_live_… POSTEAHORA_API_URL=https://api.posteahora.com/functions/v1/api npm start
```
