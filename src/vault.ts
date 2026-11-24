// R2-backed vault operations. A port of the Go vault-api handlers
// (services/obsidian-vault-api) from the local filesystem to an R2 bucket.

export interface VaultConfig {
  bucket: R2Bucket;
  history?: R2Bucket;
  /** Key prefix inside the bucket where the vault lives ("" = bucket root). */
  prefix: string;
  readAllow: string[];
  writeAllow: string[];
  stagingPrefix: string;
  maxFileBytes: number;
}

export class VaultError extends Error {}

const MD_EXT = /\.(md|markdown)$/i;
// Free-plan Workers can make 1,000 calls to Cloudflare services per request.
// Leave headroom for list calls and the occasional extra.
const MAX_SEARCH_READS = 900;
const SEARCH_CONCURRENCY = 25;

/** Normalize a vault-relative path and reject anything that could escape the vault. */
export function cleanPath(raw: string): string {
  let p = (raw ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (p.includes("\0")) throw new VaultError("invalid path");
  const parts = p.split("/").filter((s) => s !== "");
  if (parts.some((s) => s === "." || s === "..")) throw new VaultError("path may not contain . or .. segments");
  return parts.join("/");
}

function folderOf(p: string): string {
  return cleanPath(p).replace(/\/+$/, "");
}

function under(rel: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return true;
  if (prefixes.includes("*")) return true;
  return prefixes.some((p) => rel === p || rel.startsWith(p + "/"));
}

function requireMarkdown(rel: string) {
  if (!MD_EXT.test(rel)) throw new VaultError("only markdown (.md) files are allowed");
}

export function parseList(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s === "*" ? s : folderOf(s)));
}

export class Vault {
  constructor(private cfg: VaultConfig) {}

  private key(rel: string): string {
    return this.cfg.prefix + rel;
  }

  private rel(key: string): string {
    return key.slice(this.cfg.prefix.length);
  }

  private checkRead(rel: string) {
    if (!under(rel, this.cfg.readAllow)) throw new VaultError("path not allowed");
  }

  /** List markdown notes, optionally under a folder. */
  async list(folder = ""): Promise<string[]> {
    const f = folderOf(folder);
    if (f) this.checkRead(f);
    const listPrefix = this.key(f ? f + "/" : "");
    const notes: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.cfg.bucket.list({ prefix: listPrefix, cursor, limit: 1000 });
      for (const obj of page.objects) {
        const rel = this.rel(obj.key);
        if (MD_EXT.test(rel) && under(rel, this.cfg.readAllow)) notes.push(rel);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return notes.sort();
  }

  async get(path: string): Promise<{ path: string; content: string }> {
    const rel = cleanPath(path);
    requireMarkdown(rel);
    this.checkRead(rel);
    const obj = await this.cfg.bucket.get(this.key(rel));
    if (!obj) throw new VaultError(`not found: ${rel}`);
    if (obj.size > this.cfg.maxFileBytes) throw new VaultError("file too large");
    return { path: rel, content: await obj.text() };
  }

  async batchGet(paths: string[]) {
    if (!Array.isArray(paths) || paths.length === 0) throw new VaultError("missing paths");
    if (paths.length > 50) throw new VaultError("too many paths (max 50)");
    return Promise.all(
      paths.map(async (p) => {
        try {
          return await this.get(p);
        } catch (e) {
          return { path: p, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
  }

  /** Case-insensitive full-text search over note paths and contents. */
  async search(q: string, limit = 50, folder = "") {
    const needle = q.trim().toLowerCase();
    if (!needle) throw new VaultError("missing q");
    limit = Math.min(Math.max(1, Math.floor(limit) || 50), 200);

    const all = await this.list(folder);
    const candidates = all.slice(0, MAX_SEARCH_READS);
    const hits: { path: string; snippet: string }[] = [];

    for (let i = 0; i < candidates.length && hits.length < limit; i += SEARCH_CONCURRENCY) {
      const batch = candidates.slice(i, i + SEARCH_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (rel) => {
          const obj = await this.cfg.bucket.get(this.key(rel));
          if (!obj || obj.size > this.cfg.maxFileBytes) return null;
          const text = await obj.text();
          const idx = text.toLowerCase().indexOf(needle);
          if (idx >= 0) {
            const start = Math.max(0, idx - 120);
            const snippet = text.slice(start, idx + needle.length + 120).replace(/\s+/g, " ").trim();
            return { path: rel, snippet: (start > 0 ? "…" : "") + snippet };
          }
          if (rel.toLowerCase().includes(needle)) return { path: rel, snippet: "(matched file name)" };
          return null;
        }),
      );
      for (const r of results) if (r && hits.length < limit) hits.push(r);
    }

    return {
      q,
      count: hits.length,
      hits,
      ...(all.length > candidates.length
        ? { warning: `vault has ${all.length} notes; only the first ${candidates.length} were searched. Narrow with folder.` }
        : {}),
    };
  }

  /** Write directly into the vault. Path must be under WRITE_ALLOW_PREFIXES. */
  async write(path: string, content: string, overwrite = false) {
    const rel = cleanPath(path);
    requireMarkdown(rel);
    if (this.cfg.writeAllow.length === 0) throw new VaultError("direct writes are not enabled; use draft_note");
    if (!under(rel, this.cfg.writeAllow)) {
      throw new VaultError(`direct writes are only allowed under: ${this.cfg.writeAllow.join(", ")}. Use draft_note instead.`);
    }
    return this.put(rel, content, overwrite);
  }

  /** Write to the staging folder for review. */
  async draft(path: string, content: string, overwrite = false) {
    const rel = cleanPath(`${this.cfg.stagingPrefix}/${cleanPath(path)}`);
    requireMarkdown(rel);
    return this.put(rel, content, overwrite);
  }

  private async put(rel: string, content: string, overwrite: boolean) {
    if (typeof content !== "string") throw new VaultError("missing content");
    if (new TextEncoder().encode(content).length > this.cfg.maxFileBytes) throw new VaultError("content too large");

    const key = this.key(rel);
    const existing = await this.cfg.bucket.get(key);
    if (existing && !overwrite) {
      throw new VaultError(`${rel} already exists. Read it first, then call again with overwrite: true to replace it.`);
    }
    let backedUp: string | undefined;
    if (existing && this.cfg.history) {
      backedUp = `${rel}@${new Date().toISOString()}`;
      await this.cfg.history.put(backedUp, existing.body, {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      });
    }
    await this.cfg.bucket.put(key, content, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
    return { path: rel, created: !existing, ...(backedUp ? { previous_version_saved_as: backedUp } : {}) };
  }
}
