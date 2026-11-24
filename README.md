# obsidian-vault-worker

A remote MCP server for the Obsidian vault, running on Cloudflare Workers with
the vault stored in R2. It replaces the Pi-hosted Go API + local stdio MCP
client: Claude connects to it as a custom connector from any device, including
the phone app, and there's no server to keep running.

```
Obsidian (laptop) ──┐
                    ├── Remotely Save plugin ──► R2 bucket "obsidian-vault" ◄── this Worker ◄── Claude
Obsidian (Android) ─┘
```

## Tools

| Tool | What it does |
|------|--------------|
| `list_notes(folder?)` | List notes, optionally under a folder |
| `get_note(path)` | Read one note → `{path, etag, content}` |
| `batch_get_notes(paths[≤50])` | Read up to 50 notes → `[{path, etag, content}]` |
| `search_notes(q, folder?, limit?)` | Case-insensitive search over contents and file names |
| `create_note(path, content, overwrite?, if_match?)` | Write a whole note. Create-only unless `overwrite` |
| `draft_note(path, content, overwrite?, if_match?)` | Same, but into `_Staging/` for review |
| `update_note(path, mode, content, target?, if_match?)` | Edit part of a note: `replace_section`, `append_section`, `prepend`, `append` |
| `set_frontmatter_key(path, key, value, if_match?)` | Set one frontmatter key (`null` deletes) |
| `create_session_from_template(session_number, title?, date?)` | New session note from `Templates/Session.md.md` |
| `get_campaign_state()` | Dashboard, TODO, newest session, PCs/plots/NPCs, and warnings in one call |

### Editing rules

- **Sections.** A section is a heading plus everything up to the next heading of the
  same or higher level, so a `#` section includes its `##` subsections. A trailing
  `---` divider at the end of a section is kept when the section is replaced. `---`
  anywhere but line 1 is ordinary content, and `#` lines inside code fences are
  never headings. A missing or duplicated heading is an error that lists every
  heading in the note; nothing is ever silently skipped.
- **Etags.** Reads return each note's R2 etag. Pass it back as `if_match` on a
  write: if the note changed in between (for example, a phone edit synced to R2),
  the write is refused and the error returns the current etag and content to
  merge into. Every write is also conditional on the version it read, enforced by
  R2, so two writers can't silently overwrite each other.
- **History.** Every overwrite or edit saves the previous version to the
  `obsidian-vault-history` bucket as `<path>@<timestamp>`.

## Security

- `/mcp` needs an OAuth access token. Claude gets one by sending you through a
  consent page and a GitHub login; only users in `ALLOWED_GITHUB_USERS` get in.
- Paths are normalized, `..` is rejected, and only `.md`/`.markdown` files can be read or written.
- Tokens are stored hashed in KV (handled by `@cloudflare/workers-oauth-provider`).

## Setup

Everything runs from this folder in WSL. You need a Cloudflare account and `michaelkness.com` on Cloudflare.

### 1. Install and log in

```bash
npm install
npx wrangler login
```

### 2. Create the storage

```bash
npx wrangler r2 bucket create obsidian-vault
npx wrangler r2 bucket create obsidian-vault-history
npx wrangler kv namespace create OAUTH_KV
```

Put the KV `id` it prints into `wrangler.jsonc` in place of `REPLACE_WITH_KV_NAMESPACE_ID`.

### 3. Create a GitHub OAuth app

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App:

- **Homepage URL:** `https://vault-mcp.michaelkness.com`
- **Authorization callback URL:** `https://vault-mcp.michaelkness.com/callback`

Generate a client secret, then:

```bash
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

### 4. Deploy

```bash
npx wrangler deploy
```

`https://vault-mcp.michaelkness.com/` should now show a short "Obsidian vault MCP server" page.
(To use the `workers.dev` URL instead, delete `routes` from `wrangler.jsonc` and set `PUBLIC_URL` to that URL.)

### 5. Sync the vault with Remotely Save

**Back up the vault folder first** (zip it).

1. Cloudflare dashboard → R2 → *Manage API tokens* → create a token with
   **Object Read & Write**, limited to the `obsidian-vault` bucket. Note the
   Access Key ID, Secret Access Key, and the S3 endpoint
   (`https://<account-id>.r2.cloudflarestorage.com`).
2. On the **laptop**, install the *Remotely Save* community plugin and choose S3-compatible storage:
   - Endpoint: the S3 endpoint above
   - Region: `auto`
   - Access Key ID / Secret Access Key: from the token
   - Bucket: `obsidian-vault`
   - **Leave encryption off**: the Worker has to be able to read the notes.
3. Run a sync, then look at the bucket in the dashboard. If the notes landed under
   a folder (e.g. `ETU/Characters/...`) instead of at the top level, set
   `VAULT_PREFIX` in `wrangler.jsonc` to that folder and redeploy.
4. On the **phone**, open Obsidian, create or open the vault, and set up Remotely Save
   with the same settings. Sync to pull everything down.
5. Turn on automatic sync (on startup and every few minutes) on both devices.

If the phone's sync fails with a network/CORS error, add this CORS policy to the
bucket (R2 → obsidian-vault → Settings → CORS):

```json
[{ "AllowedOrigins": ["app://obsidian.md", "capacitor://localhost", "http://localhost"],
   "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
   "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
```

### 6. Connect Claude

In Claude's settings, add a custom connector with the URL
`https://vault-mcp.michaelkness.com/mcp`. Claude opens the consent page →
*Continue with GitHub* → you're connected. It then works from every Claude
app signed into your account, phone included.

## Configuration (`wrangler.jsonc` → `vars`)

| Var | Default | Notes |
|-----|---------|-------|
| `PUBLIC_URL` | — | Origin the Worker is served on. Must match exactly. |
| `ALLOWED_GITHUB_USERS` | — | Comma-separated GitHub usernames |
| `VAULT_PREFIX` | `""` | Folder inside the bucket where the vault lives |
| `READ_ALLOW_PREFIXES` | all | Comma-separated folders Claude may read |
| `WRITE_ALLOW_PREFIXES` | `*` | Folders `create_note` may write to. `*` = anywhere, empty = drafts only |
| `STAGING_PREFIX` | `_Staging` | Where `draft_note` writes |
| `CAMPAIGN_ROOT` | `Degrees of Horror` | Campaign folder for the session and campaign-state tools |
| `TEMPLATES_DIR` | `Templates` | Where `create_session_from_template` looks for `Session.md.md` |

## Limits

On the free Workers plan a request can make 1,000 calls to R2, so `search_notes`
reads at most 900 notes per call and says so if the vault is bigger (pass
`folder` to narrow it). If the vault outgrows that, the $5/month plan lifts it.

## Tests

```bash
npm test
```

Tests run inside the Workers runtime against local R2 buckets
(`@cloudflare/vitest-plugin`). `test/markdown.test.ts` covers the section and
frontmatter parser; `test/tools.test.ts` makes real MCP calls to every tool.

## Local testing by hand

```bash
# Tools only, no auth, against a local R2 bucket:
cd test && npx wrangler dev -c wrangler.test.jsonc --port 8799
# Full Worker with GitHub stubbed (needs a .dev.vars with dummy GITHUB_CLIENT_ID/SECRET):
cd test && npx wrangler dev -c wrangler.auth.jsonc --port 8798
```

The files in `test/` are local harnesses. Never deploy them.
