import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ConflictError, Vault, VaultError } from "./vault";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const json = (data: unknown) => (typeof data === "string" ? data : JSON.stringify(data, null, 2));

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: "text", text: json(await fn()) }] };
  } catch (e) {
    if (e instanceof ConflictError) {
      return {
        content: [
          {
            type: "text",
            text: json({ error: "conflict", message: e.message, current_etag: e.current.etag, current_content: e.current.content }),
          },
        ],
        isError: true,
      };
    }
    const msg = e instanceof VaultError || e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
}

const IF_MATCH = z
  .string()
  .optional()
  .describe(
    "The etag from your most recent get_note/batch_get_notes/write result for this note. If the note has changed since (e.g. Michael edited it and synced), the write is refused and the error returns the current etag and content: merge your change into that and retry with the new etag. Strongly recommended.",
  );

const SECTION_RULES =
  "Section rules: `target` is the heading text exactly as written, without the #'s (e.g. 'The Goal'); add the #'s ('## Session Log') only to pick a level when the same text exists at several levels. " +
  "A section runs from its heading to the next heading of the SAME OR HIGHER level (fewer #'s), so nested subheadings belong to it: replacing a '#' heading's section replaces all of its '##' subsections too. " +
  "A trailing '---' divider and blank lines at the very end of a section are kept, so dividers between sections survive. " +
  "'---' inside your content is fine. Lines inside ``` code fences are never treated as headings. " +
  "If the heading is missing or appears more than once, nothing is written and the error lists every heading in the note.";

export interface ServerOptions {
  writeAllow: string[];
  stagingPrefix: string;
  campaignRoot: string;
  templatesDir: string;
}

export function buildServer(vault: Vault, opts: ServerOptions): McpServer {
  const { writeAllow, stagingPrefix, campaignRoot, templatesDir } = opts;
  const server = new McpServer(
    { name: "obsidian-vault", version: "2.1.0" },
    {
      instructions:
        "Tools for Michael's Obsidian vault of tabletop RPG notes (Savage Worlds campaign under '" +
        campaignRoot +
        "/'). Paths are vault-relative (e.g. '" +
        campaignRoot +
        "/NPC Wildcards/Nina.md'). Start campaign work with get_campaign_state. " +
        "Edit workflow: read with get_note (it returns an etag), then edit with update_note or set_frontmatter_key passing if_match=<etag>. " +
        "Prefer update_note over rewriting whole notes. On a conflict error, merge into the returned current content and retry with the new etag. " +
        `create_note writes directly (allowed under: ${writeAllow.length ? writeAllow.join(", ") : "nowhere"}); draft_note writes to ${stagingPrefix}/ for review.`,
    },
  );

  server.registerTool(
    "list_notes",
    {
      description: "List markdown notes in the vault, optionally only those under a folder.",
      inputSchema: z.object({
        folder: z.string().optional().describe("Vault-relative folder, e.g. 'Degrees of Horror/Plots'. Omit to list everything."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ folder }) =>
      run(async () => {
        const notes = await vault.list(folder ?? "");
        return { count: notes.length, notes };
      }),
  );

  server.registerTool(
    "get_note",
    {
      description: "Read one note. Returns {path, etag, content}. Pass the etag as if_match when you edit the note.",
      inputSchema: z.object({ path: z.string().describe("Vault-relative path, e.g. 'Degrees of Horror/Dashboard.md'.") }),
      annotations: { readOnlyHint: true },
    },
    async ({ path }) => run(() => vault.get(path)),
  );

  server.registerTool(
    "batch_get_notes",
    {
      description: "Read up to 50 notes at once. Returns [{path, etag, content}] (or {path, error} for notes that couldn't be read).",
      inputSchema: z.object({ paths: z.array(z.string()).min(1).max(50) }),
      annotations: { readOnlyHint: true },
    },
    async ({ paths }) => run(() => vault.batchGet(paths)),
  );

  server.registerTool(
    "search_notes",
    {
      description: "Case-insensitive full-text search across note contents and file names. Returns paths with snippets.",
      inputSchema: z.object({
        q: z.string().min(1).describe("Text to search for."),
        limit: z.number().int().min(1).max(200).optional().describe("Max hits (default 50)."),
        folder: z.string().optional().describe("Only search under this folder."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ q, limit, folder }) => run(() => vault.search(q, limit ?? 50, folder ?? "")),
  );

  server.registerTool(
    "create_note",
    {
      description:
        "Write a whole note. Without overwrite it only creates: if the note exists, nothing is written and you get an error (never a silent no-op). " +
        "To replace an existing note, pass overwrite: true and if_match with the etag from get_note. For edits to part of a note, use update_note instead. " +
        "Returns {path, created, etag}.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path ending in .md."),
        content: z.string().describe("Full markdown content."),
        overwrite: z.boolean().optional().describe("Replace an existing note. Default false."),
        if_match: IF_MATCH,
      }),
      annotations: { destructiveHint: true },
    },
    async ({ path, content, overwrite, if_match }) => run(() => vault.write(path, content, { overwrite, ifMatch: if_match })),
  );

  server.registerTool(
    "draft_note",
    {
      description: `Write a whole note into ${stagingPrefix}/ for Michael to review before moving it into the vault. Same create/overwrite/if_match rules as create_note.`,
      inputSchema: z.object({
        path: z.string().describe(`Intended vault path, e.g. 'NPCs/New NPC.md' (saved as ${stagingPrefix}/NPCs/New NPC.md).`),
        content: z.string().describe("Full markdown content."),
        overwrite: z.boolean().optional().describe("Replace an existing draft. Default false."),
        if_match: IF_MATCH,
      }),
    },
    async ({ path, content, overwrite, if_match }) => run(() => vault.draft(path, content, { overwrite, ifMatch: if_match })),
  );

  server.registerTool(
    "update_note",
    {
      description:
        "Edit part of an existing note without resending the whole file. Modes: " +
        "'replace_section' replaces everything under the `target` heading (the heading line itself is kept); " +
        "'append_section' adds `content` at the end of the `target` section, after its nested subsections and before the next same-or-higher heading; " +
        "'prepend' adds `content` at the top of the body, just after the frontmatter; 'append' adds it at the end of the note. " +
        "'prepend'/'append' need no target and work on empty notes. " +
        SECTION_RULES +
        " Returns {path, etag, changed, diff}. Frontmatter is never touched; use set_frontmatter_key for that.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path of an existing note."),
        mode: z.enum(["replace_section", "append_section", "prepend", "append"]),
        content: z.string().describe("Markdown to insert. Don't include the target heading line itself."),
        target: z.string().optional().describe("Heading text for the *_section modes, e.g. 'Session Log'."),
        if_match: IF_MATCH,
      }),
      annotations: { destructiveHint: true },
    },
    async ({ path, mode, content, target, if_match }) => run(() => vault.update(path, mode, content, target, if_match)),
  );

  server.registerTool(
    "set_frontmatter_key",
    {
      description:
        "Set or delete one frontmatter (YAML properties) key, keeping every other key, its order and formatting. " +
        "`value` is JSON: a string or number for a single value (e.g. aliases: 'Jackson Green'), an array for a real YAML list (e.g. ['[[Willie Greenhorn]]', 'Willie']), true/false, or null to delete the key. " +
        "Wikilinks are quoted correctly automatically. Don't pass a list as a string like \"['a']\": that's rejected. " +
        "If the note has no frontmatter, it's created. If the body contains frontmatter-looking text (a second '---' block or key: value lines at the top), nothing is written and the error describes it. " +
        "Returns {path, etag, changed, frontmatter}.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path of an existing note."),
        key: z.string().min(1),
        value: z.any().describe("JSON value; null deletes the key."),
        if_match: IF_MATCH,
      }),
      annotations: { destructiveHint: true },
    },
    async ({ path, key, value, if_match }) => run(() => vault.setFrontmatter(path, key, value ?? null, if_match)),
  );

  server.registerTool(
    "create_session_from_template",
    {
      description:
        `Create a new session note from ${templatesDir}/Session.md.md, saved as '${campaignRoot}/Session Notes/Session {n} - {title}.md' (or 'Session {n}.md' with no title). ` +
        "Fills {{NUMBER}} and {{TITLE}}, the session/title/real_date frontmatter, and the Real Date line. " +
        "Fails without writing if a note for that session number already exists in either session folder. Returns {path, etag, template}.",
      inputSchema: z.object({
        session_number: z.number().int().min(0),
        title: z.string().optional(),
        date: z.string().optional().describe("Real-world session date, written as given (e.g. 'Dec 6, 2026')."),
      }),
      annotations: { destructiveHint: false },
    },
    async ({ session_number, title, date }) => run(() => vault.createSessionFromTemplate(session_number, title, date)),
  );

  server.registerTool(
    "get_campaign_state",
    {
      description:
        "One-call snapshot of the campaign: Dashboard and TODO (full content, plus open TODO items), the newest session note in full, " +
        "every session note (number/title/status, from both session folders), the Player Wildcards, Plots and NPC Wildcards with their frontmatter, " +
        "and warnings (duplicate session notes, Dashboard out of date, unfilled {{placeholders}}, doubled YAML). Read-only.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => run(() => vault.campaignState()),
  );

  return server;
}
