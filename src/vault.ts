// R2-backed vault operations.

import {
  applyEdit,
  frontmatterObject,
  headings,
  type EditMode,
  type JsonValue,
  MarkdownError,
  parse,
  parseFrontmatter,
  serialize,
  setFrontmatterKey,
  strayFrontmatter,
  summarizeEdit,
} from "./markdown";

export interface VaultConfig {
  bucket: R2Bucket;
  history?: R2Bucket;
  /** Key prefix inside the bucket where the vault lives ("" = bucket root). */
  prefix: string;
  readAllow: string[];
  writeAllow: string[];
  stagingPrefix: string;
  maxFileBytes: number;
  /** Folder holding the campaign (Dashboard, TODO, Session Notes, …). */
  campaignRoot: string;
  templatesDir: string;
}

export class VaultError extends Error {}

/** A write was refused because the note changed since the caller read it. */
export class ConflictError extends VaultError {
  constructor(
    message: string,
    public current: { path: string; etag: string | null; content: string | null },
  ) {
    super(message);
  }
}

const MD_EXT = /\.(md|markdown)$/i;
// Free-plan Workers can make 1,000 calls to Cloudflare services per request.
const MAX_SEARCH_READS = 900;
const SEARCH_CONCURRENCY = 25;
const CONTENT_TYPE = { contentType: "text/markdown; charset=utf-8" };

/** Normalize a vault-relative path and reject anything that could escape the vault. */
export function cleanPath(raw: string): string {
  const p = (raw ?? "").trim().replace(/\\/g, "/");
  if (p.includes("\0")) throw new VaultError("invalid path");
  if (/^[A-Za-z]:\//.test(p)) throw new VaultError("absolute paths aren't allowed; use a vault-relative path");
  const parts = p.replace(/^\/+/, "").split("/").filter((s) => s !== "");
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

/** Accept etags with or without the surrounding quotes R2's httpEtag uses. */
function normEtag(e: string | undefined): string | undefined {
  if (e === undefined) return undefined;
  const t = e.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1");
  return t || undefined;
}

export function parseList(v: string | undefined): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s === "*" ? s : folderOf(s)));
}

/** "Session 12 - Title.md" → { number: 12, title: "Title" } */
export function parseSessionFilename(rel: string): { number: number; title: string } | null {
  const name = rel.split("/").pop()!.replace(MD_EXT, "");
  const m = name.match(/^Session\s+(\d+)(?:\s*-\s*(.*))?$/i);
  return m ? { number: Number(m[1]), title: (m[2] ?? "").trim() } : null;
}

function sanitizeTitleForFilename(title: string): string {
  // Characters Obsidian or common filesystems don't allow in file names.
  return title.replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim();
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

  private checkWrite(rel: string) {
    if (this.cfg.writeAllow.length === 0) throw new VaultError("direct writes are not enabled; use draft_note");
    if (!under(rel, this.cfg.writeAllow)) {
      throw new VaultError(`direct writes are only allowed under: ${this.cfg.writeAllow.join(", ")}. Use draft_note instead.`);
    }
  }

  private checkSize(content: string) {
    if (new TextEncoder().encode(content).length > this.cfg.maxFileBytes) throw new VaultError("content too large");
  }

  // -------------------------------------------------------------------------
  // Reads

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

  async get(path: string): Promise<{ path: string; etag: string; content: string }> {
    const rel = cleanPath(path);
    requireMarkdown(rel);
    this.checkRead(rel);
    const obj = await this.cfg.bucket.get(this.key(rel));
    if (!obj) throw new VaultError(`not found: ${rel}`);
    if (obj.size > this.cfg.maxFileBytes) throw new VaultError("file too large");
    return { path: rel, etag: obj.etag, content: await obj.text() };
  }

  private async tryGet(rel: string) {
    try {
      return await this.get(rel);
    } catch (e) {
      if (e instanceof VaultError && e.message.startsWith("not found")) return null;
      throw e;
    }
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

  // -------------------------------------------------------------------------
  // Writes

  /** Whole-note write into the vault. */
  async write(path: string, content: string, opts: { overwrite?: boolean; ifMatch?: string } = {}) {
    const rel = cleanPath(path);
    requireMarkdown(rel);
    this.checkWrite(rel);
    return this.putWhole(rel, content, opts);
  }

  /** Whole-note write into the staging folder. */
  async draft(path: string, content: string, opts: { overwrite?: boolean; ifMatch?: string } = {}) {
    const rel = cleanPath(`${this.cfg.stagingPrefix}/${cleanPath(path)}`);
    requireMarkdown(rel);
    return this.putWhole(rel, content, opts);
  }

  private async putWhole(rel: string, content: string, opts: { overwrite?: boolean; ifMatch?: string }) {
    if (typeof content !== "string") throw new VaultError("missing content");
    this.checkSize(content);
    const ifMatch = normEtag(opts.ifMatch);
    if (ifMatch && !opts.overwrite) throw new VaultError("if_match only applies when replacing a note; pass overwrite: true with it");

    if (!opts.overwrite) {
      // Create-only, enforced by R2 so a note can't appear between check and write.
      const put = await this.cfg.bucket.put(this.key(rel), content, {
        httpMetadata: CONTENT_TYPE,
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (!put) {
        const cur = await this.tryGet(rel);
        throw new ConflictError(
          `${rel} already exists. Nothing was written. To replace it, read it with get_note, then call again with overwrite: true and if_match set to its etag.`,
          { path: rel, etag: cur?.etag ?? null, content: null },
        );
      }
      return { path: rel, created: true, etag: put.etag };
    }

    const existing = await this.tryGet(rel);
    if (ifMatch && (!existing || existing.etag !== ifMatch)) {
      throw new ConflictError(
        existing
          ? `${rel} changed since you read it (etag ${existing.etag}, you sent ${ifMatch}). Nothing was written. Merge your change into the current content below and retry with the new etag.`
          : `${rel} no longer exists. Nothing was written.`,
        { path: rel, etag: existing?.etag ?? null, content: existing?.content ?? null },
      );
    }
    return this.commit(rel, content, existing);
  }

  /**
   * Write `content` over `existing` (or create it if `existing` is null),
   * failing if the note changed in between. Saves the previous version to the
   * history bucket.
   */
  private async commit(rel: string, content: string, existing: { etag: string; content: string } | null) {
    const put = await this.cfg.bucket.put(this.key(rel), content, {
      httpMetadata: CONTENT_TYPE,
      onlyIf: existing ? { etagMatches: existing.etag } : { etagDoesNotMatch: "*" },
    });
    if (!put) {
      const cur = await this.tryGet(rel);
      throw new ConflictError(
        `${rel} changed while this write was in progress. Nothing was written. Merge into the current content below and retry with the new etag.`,
        { path: rel, etag: cur?.etag ?? null, content: cur?.content ?? null },
      );
    }
    let backedUp: string | undefined;
    if (existing && this.cfg.history) {
      backedUp = `${rel}@${new Date().toISOString()}`;
      await this.cfg.history.put(backedUp, existing.content, { httpMetadata: CONTENT_TYPE });
    }
    return { path: rel, created: !existing, etag: put.etag, ...(backedUp ? { previous_version_saved_as: backedUp } : {}) };
  }

  /** Read a note for an in-place edit, enforcing if_match. */
  private async readForEdit(path: string, ifMatch?: string) {
    const rel = cleanPath(path);
    requireMarkdown(rel);
    this.checkWrite(rel);
    const cur = await this.tryGet(rel);
    if (!cur) throw new VaultError(`not found: ${rel}. Use create_note to make a new note.`);
    const want = normEtag(ifMatch);
    if (want && want !== cur.etag) {
      throw new ConflictError(
        `${rel} changed since you read it (etag ${cur.etag}, you sent ${want}). Nothing was written. Re-apply your edit to the current content below and retry with the new etag.`,
        cur,
      );
    }
    return cur;
  }

  async update(path: string, mode: EditMode, content: string, target?: string, ifMatch?: string) {
    if (typeof content !== "string") throw new VaultError("missing content");
    const cur = await this.readForEdit(path, ifMatch);
    const doc = parse(cur.content);
    let result;
    try {
      result = applyEdit(doc.body, mode, content, target);
    } catch (e) {
      if (e instanceof MarkdownError) throw new VaultError(`${cur.path}: ${e.message}`);
      throw e;
    }
    const next = serialize({ ...doc, body: result.body });
    this.checkSize(next);
    if (next === cur.content) return { path: cur.path, etag: cur.etag, changed: false, diff: "(no change)" };
    const written = await this.commit(cur.path, next, cur);
    return { ...written, changed: true, diff: summarizeEdit(result) };
  }

  async setFrontmatter(path: string, key: string, value: JsonValue, ifMatch?: string) {
    const cur = await this.readForEdit(path, ifMatch);
    // Catch an opening --- with no closing fence before parse() treats it as body text.
    const firstLine = cur.content.replace(/^﻿/, "").split(/\r?\n/, 1)[0];
    const doc = parse(cur.content);
    if (firstLine.trimEnd() === "---" && doc.frontmatter === null) {
      throw new VaultError(`${cur.path}: the note opens with '---' but the frontmatter is never closed. Fix it in Obsidian first.`);
    }
    const stray = strayFrontmatter(doc.body);
    if (stray) {
      throw new VaultError(
        `${cur.path}: ${stray}. Writing frontmatter now would leave two YAML blocks. Clean it up in Obsidian (source mode), then retry.`,
      );
    }
    let raw: string;
    try {
      raw = setFrontmatterKey(doc.frontmatter, key, value);
    } catch (e) {
      if (e instanceof MarkdownError) throw new VaultError(`${cur.path}: ${e.message}`);
      throw e;
    }
    const body = doc.frontmatter === null && doc.body.length && doc.body[0].trim() !== "" ? ["", ...doc.body] : doc.body;
    const next = serialize({ ...doc, frontmatter: raw === "" ? null : raw, body });
    if (next === cur.content) return { path: cur.path, etag: cur.etag, changed: false, frontmatter: frontmatterObject(doc.frontmatter) };
    const written = await this.commit(cur.path, next, cur);
    return { ...written, changed: true, frontmatter: frontmatterObject(raw) };
  }

  // -------------------------------------------------------------------------
  // Campaign tools

  private sessionFolders(): string[] {
    const root = this.cfg.campaignRoot;
    return [`${root}/Session Notes`, "Session Notes"];
  }

  async createSessionFromTemplate(sessionNumber: number, title?: string, date?: string) {
    if (!Number.isInteger(sessionNumber) || sessionNumber < 0) throw new VaultError("session_number must be a whole number");
    const tplDir = this.cfg.templatesDir;
    const candidates = [`${tplDir}/Session.md.md`, `${tplDir}/Session.md`];
    let tpl = null;
    for (const c of candidates) if ((tpl = await this.tryGet(c))) break;
    if (!tpl) throw new VaultError(`session template not found (looked for ${candidates.join(" and ")})`);

    const cleanTitle = title ? sanitizeTitleForFilename(title) : "";
    const fileName = `Session ${sessionNumber}${cleanTitle ? ` - ${cleanTitle}` : ""}.md`;
    const rel = cleanPath(`${this.cfg.campaignRoot}/Session Notes/${fileName}`);
    this.checkWrite(rel);

    const clashes: string[] = [];
    for (const folder of this.sessionFolders()) {
      for (const p of await this.list(folder)) {
        if (p.slice(folder.length + 1).includes("/")) continue;
        if (parseSessionFilename(p)?.number === sessionNumber) clashes.push(p);
      }
    }
    if (clashes.length) {
      throw new VaultError(`A note for session ${sessionNumber} already exists: ${clashes.join(", ")}. Nothing was written.`);
    }

    // Fill the body.
    let text = tpl.content.replace(/\{\{NUMBER\}\}/g, String(sessionNumber));
    text = title
      ? text.replace(/\{\{TITLE\}\}/g, title.trim())
      : text.replace(/[ \t]*[—–-][ \t]*\{\{TITLE\}\}/g, "").replace(/\{\{TITLE\}\}/g, "");
    const doc = parse(text);
    if (date) {
      doc.body = doc.body.map((l) => l.replace(/^(\s*>?\s*\*\*Real Date:\*\*)[ \t]*$/, `$1 ${date}`));
    }

    // Fill the frontmatter: always the session number; title and date where the template has keys for them.
    let raw = doc.frontmatter;
    const keys = Object.keys(frontmatterObject(raw));
    raw = setFrontmatterKey(raw, "session", sessionNumber);
    if (title || keys.includes("title")) raw = setFrontmatterKey(raw, "title", title?.trim() ?? "");
    if (date) {
      const dateKeys = ["real_date", "date"].filter((k) => keys.includes(k));
      for (const k of dateKeys.length ? dateKeys : ["real_date"]) raw = setFrontmatterKey(raw, k, date);
    }
    const content = serialize({ ...doc, frontmatter: raw });
    this.checkSize(content);

    const written = await this.commit(rel, content, null);
    return { ...written, template: tpl.path, title: title?.trim() || null };
  }

  async campaignState() {
    const root = this.cfg.campaignRoot;
    const warnings: string[] = [];

    const readNote = async (rel: string) => {
      const n = await this.tryGet(rel);
      if (!n) return null;
      const doc = parse(n.content);
      let frontmatter: Record<string, unknown> = {};
      if (doc.frontmatter !== null) {
        try {
          frontmatter = (parseFrontmatter(doc.frontmatter).toJS() ?? {}) as Record<string, unknown>;
        } catch (e) {
          warnings.push(`${rel}: ${(e as Error).message}`);
        }
      }
      const h1 = headings(doc.body).find((h) => h.level === 1);
      if (/\{\{[^}]+\}\}/.test(n.content)) warnings.push(`${rel}: has unfilled template placeholders ({{…}})`);
      if (strayFrontmatter(doc.body)) warnings.push(`${rel}: has frontmatter-looking text in the body (possible doubled YAML block)`);
      return { ...n, frontmatter, title: h1?.text ?? null, body: doc.body };
    };

    const [dashboard, todo] = await Promise.all([readNote(`${root}/Dashboard.md`), readNote(`${root}/TODO.md`)]);
    if (!dashboard) warnings.push(`${root}/Dashboard.md not found`);
    if (!todo) warnings.push(`${root}/TODO.md not found`);

    // Open TODO items, grouped by the heading they sit under.
    const openItems: { section: string | null; item: string }[] = [];
    if (todo) {
      let section: string | null = null;
      for (const line of todo.body) {
        const h = line.match(/^ {0,3}#{1,6}[ \t]+(.*?)[ \t]*$/);
        if (h) section = h[1];
        const m = line.match(/^\s*[-*+] \[ \] (.+)$/);
        if (m) openItems.push({ section, item: m[1].trim() });
      }
    }

    // Sessions from both folders.
    const sessionPaths: string[] = [];
    for (const folder of this.sessionFolders()) {
      for (const p of await this.list(folder)) if (!p.slice(folder.length + 1).includes("/")) sessionPaths.push(p);
    }
    const sessionNotes = (await Promise.all(sessionPaths.map(readNote))).filter((n) => n !== null);
    const sessions = sessionNotes
      .map((n) => {
        const fromName = parseSessionFilename(n.path);
        const fmNum = Number(n.frontmatter.session);
        const number = Number.isFinite(fmNum) && n.frontmatter.session !== undefined && n.frontmatter.session !== "" ? fmNum : fromName?.number ?? null;
        return {
          path: n.path,
          number,
          title: (n.frontmatter.title as string) || fromName?.title || n.title,
          status: (n.frontmatter.status as string) ?? null,
          etag: n.etag,
          content: n.content,
        };
      })
      .sort((a, b) => (a.number ?? -1) - (b.number ?? -1) || a.path.localeCompare(b.path));

    const byNumber = new Map<number, string[]>();
    for (const s of sessions) if (s.number !== null) byNumber.set(s.number, [...(byNumber.get(s.number) ?? []), s.path]);
    for (const [num, paths] of byNumber) if (paths.length > 1) warnings.push(`Duplicate notes for session ${num}: ${paths.join(", ")}`);

    // Latest = highest number; on a tie prefer the campaign folder, then the longer note.
    const numbered = sessions.filter((s) => s.number !== null);
    const top = numbered.length ? Math.max(...numbered.map((s) => s.number!)) : null;
    const latest =
      top === null
        ? null
        : numbered
            .filter((s) => s.number === top)
            .sort(
              (a, b) =>
                Number(b.path.startsWith(root + "/")) - Number(a.path.startsWith(root + "/")) || b.content.length - a.content.length,
            )[0];

    const current = Number(dashboard?.frontmatter.current_session);
    if (latest && Number.isFinite(current) && current !== latest.number) {
      warnings.push(`Dashboard current_session is ${current}; the newest session note is ${latest.number} (${latest.path})`);
    }

    const folderSummary = async (folder: string) => {
      const paths = (await this.list(`${root}/${folder}`)).filter((p) => !p.slice(root.length + folder.length + 2).includes("/"));
      const notes = await Promise.all(paths.map(readNote));
      return notes.filter((n) => n !== null).map((n) => ({ path: n.path, title: n.title, frontmatter: n.frontmatter }));
    };
    const [player_wildcards, plots, npc_wildcards] = await Promise.all([
      folderSummary("Player Wildcards"),
      folderSummary("Plots"),
      folderSummary("NPC Wildcards"),
    ]);

    return {
      dashboard: dashboard && { path: dashboard.path, etag: dashboard.etag, frontmatter: dashboard.frontmatter, content: dashboard.content },
      todo: todo && { path: todo.path, etag: todo.etag, open_items: openItems, content: todo.content },
      latest_session: latest && { path: latest.path, number: latest.number, title: latest.title, status: latest.status, etag: latest.etag, content: latest.content },
      sessions: sessions.map(({ content: _c, etag: _e, ...s }) => s),
      player_wildcards,
      plots,
      npc_wildcards,
      warnings: [...new Set(warnings)],
    };
  }
}
