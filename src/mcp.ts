import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { Vault, VaultError } from "./vault";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    const msg = e instanceof VaultError || e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
  }
}

export function buildServer(vault: Vault, writeAllow: string[], stagingPrefix: string): McpServer {
  const server = new McpServer(
    { name: "obsidian-vault", version: "2.0.0" },
    {
      instructions:
        "Tools for Michael's Obsidian vault of tabletop RPG notes. Paths are vault-relative (e.g. 'NPCs/Thalindra.md'). " +
        "Look before you write: list_notes or search_notes to find existing notes and templates, and follow the vault's existing folder and formatting conventions. " +
        `create_note writes directly (allowed under: ${writeAllow.length ? writeAllow.join(", ") : "nowhere"}); ` +
        `draft_note writes to ${stagingPrefix}/ for review. Neither overwrites an existing note unless overwrite is true.`,
    },
  );

  server.registerTool(
    "list_notes",
    {
      description: "List markdown notes in the vault, optionally only those under a folder.",
      inputSchema: z.object({
        folder: z.string().optional().describe("Vault-relative folder, e.g. 'Characters'. Omit to list everything."),
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
      description: "Read the full markdown content of one note.",
      inputSchema: z.object({ path: z.string().describe("Vault-relative path, e.g. 'Characters/Daisy LaRoux.md'.") }),
      annotations: { readOnlyHint: true },
    },
    async ({ path }) => run(async () => (await vault.get(path)).content),
  );

  server.registerTool(
    "batch_get_notes",
    {
      description: "Read up to 50 notes at once.",
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
        "Write a note directly into the vault. Only allowed under approved folders; use draft_note elsewhere. " +
        "Fails if the note exists unless overwrite is true. When editing an existing note, get_note first and send the full new content.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path ending in .md."),
        content: z.string().describe("Full markdown content."),
        overwrite: z.boolean().optional().describe("Replace an existing note. Default false."),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ path, content, overwrite }) => run(() => vault.write(path, content, overwrite ?? false)),
  );

  server.registerTool(
    "draft_note",
    {
      description: `Write a note into ${stagingPrefix}/ for Michael to review before moving it into the vault.`,
      inputSchema: z.object({
        path: z.string().describe(`Intended vault path, e.g. 'NPCs/New NPC.md' (saved as ${stagingPrefix}/NPCs/New NPC.md).`),
        content: z.string().describe("Full markdown content."),
        overwrite: z.boolean().optional().describe("Replace an existing draft. Default false."),
      }),
    },
    async ({ path, content, overwrite }) => run(() => vault.draft(path, content, overwrite ?? false)),
  );

  return server;
}
