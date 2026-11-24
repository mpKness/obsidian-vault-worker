export interface Env {
  VAULT: R2Bucket;
  /** Optional second bucket that keeps the previous version of any overwritten note. */
  HISTORY?: R2Bucket;
  OAUTH_KV: KVNamespace;

  /** Public origin of this Worker, e.g. https://vault-mcp.michaelkness.com */
  PUBLIC_URL: string;

  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** Comma-separated GitHub usernames allowed to connect. */
  ALLOWED_GITHUB_USERS: string;

  /** Key prefix inside the bucket where the vault lives, e.g. "ETU/". Empty = bucket root. */
  VAULT_PREFIX?: string;
  /** Comma-separated folders that may be read. Empty = whole vault. */
  READ_ALLOW_PREFIXES?: string;
  /** Comma-separated folders create_note may write to. "*" = anywhere. Empty = disabled. */
  WRITE_ALLOW_PREFIXES?: string;
  /** Folder draft_note writes into. Default "_Staging". */
  STAGING_PREFIX?: string;
}
