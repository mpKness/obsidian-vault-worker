// End-to-end tests: real MCP JSON-RPC calls into the Worker (without OAuth,
// via test/dev-entry.ts) against local R2 buckets.
import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import SESSION_TEMPLATE from "./fixtures/Session.md.md?raw";

const VAULT = (env as any).VAULT as R2Bucket;
const HISTORY = (env as any).HISTORY as R2Bucket;
const ROOT = "Degrees of Horror";

let rpcId = 0;
async function call(name: string, args: Record<string, unknown> = {}) {
  const res = await (exports as any).default.fetch("http://localhost:8799/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-06-18",
      Host: "localhost",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const line = raw.split("\n").find((l) => l.startsWith("data: ")) ?? raw;
  const msg = JSON.parse(line.replace(/^data: /, ""));
  if (msg.error) throw new Error(JSON.stringify(msg.error));
  const text: string = msg.result.content[0].text;
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {}
  return { isError: !!msg.result.isError, data, text };
}

const put = (path: string, content: string) => VAULT.put(path, content);
const read = async (path: string) => (await VAULT.get(path))?.text();

async function clearBuckets() {
  for (const b of [VAULT, HISTORY]) {
    const listed = await b.list();
    if (listed.objects.length) await b.delete(listed.objects.map((o) => o.key));
  }
}

beforeEach(clearBuckets);

describe("tool registration", () => {
  it("lists all tools", async () => {
    const res = await (exports as any).default.fetch("http://localhost:8799/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18", Host: "localhost" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const names = [...(await res.text()).matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]);
    expect(names).toEqual(
      expect.arrayContaining([
        "list_notes",
        "get_note",
        "batch_get_notes",
        "search_notes",
        "create_note",
        "draft_note",
        "update_note",
        "set_frontmatter_key",
        "create_session_from_template",
        "get_campaign_state",
      ]),
    );
  });
});

describe("etags and if_match", () => {
  it("get_note and batch_get_notes return etags", async () => {
    await put("a.md", "# A\n");
    const one = await call("get_note", { path: "a.md" });
    expect(one.data).toMatchObject({ path: "a.md", content: "# A\n" });
    expect(one.data.etag).toMatch(/^[0-9a-f]{32}$/);
    const many = await call("batch_get_notes", { paths: ["a.md", "missing.md"] });
    expect(many.data[0].etag).toBe(one.data.etag);
    expect(many.data[1].error).toMatch(/not found/);
  });

  it("update_note rejects a stale etag and returns the current content", async () => {
    await put("n.md", "## Log\n\nfirst\n");
    const { data: before } = await call("get_note", { path: "n.md" });
    await put("n.md", "## Log\n\nedited on the phone\n");
    const res = await call("update_note", { path: "n.md", mode: "append_section", target: "Log", content: "from Claude", if_match: before.etag });
    expect(res.isError).toBe(true);
    expect(res.data.error).toBe("conflict");
    expect(res.data.current_content).toBe("## Log\n\nedited on the phone\n");
    expect(await read("n.md")).toBe("## Log\n\nedited on the phone\n");

    const retry = await call("update_note", {
      path: "n.md",
      mode: "append_section",
      target: "Log",
      content: "from Claude",
      if_match: res.data.current_etag,
    });
    expect(retry.isError).toBe(false);
    expect(await read("n.md")).toBe("## Log\n\nedited on the phone\n\nfrom Claude\n");
    expect(retry.data.etag).not.toBe(res.data.current_etag);
    expect(retry.data.diff).toContain("+from Claude");
  });

  it("accepts quoted etags", async () => {
    await put("n.md", "x\n");
    const { data } = await call("get_note", { path: "n.md" });
    const res = await call("update_note", { path: "n.md", mode: "append", content: "y", if_match: `"${data.etag}"` });
    expect(res.isError).toBe(false);
  });

  it("saves the previous version to the history bucket", async () => {
    await put("n.md", "old\n");
    await call("update_note", { path: "n.md", mode: "append", content: "new" });
    const hist = await HISTORY.list();
    expect(hist.objects).toHaveLength(1);
    expect(hist.objects[0].key).toMatch(/^n\.md@/);
    expect(await (await HISTORY.get(hist.objects[0].key))!.text()).toBe("old\n");
  });
});

describe("create_note", () => {
  // Regression: create_note failed silently on existing files.
  it("errors (and writes nothing) when the note exists", async () => {
    await put("n.md", "keep me\n");
    const res = await call("create_note", { path: "n.md", content: "replacement" });
    expect(res.isError).toBe(true);
    expect(res.data.message).toMatch(/already exists. Nothing was written/);
    expect(res.data.current_etag).toMatch(/^[0-9a-f]{32}$/);
    expect(await read("n.md")).toBe("keep me\n");
  });

  it("overwrites only with a matching if_match", async () => {
    await put("n.md", "v1\n");
    const { data } = await call("get_note", { path: "n.md" });
    const stale = await call("create_note", { path: "n.md", content: "v3", overwrite: true, if_match: "0".repeat(32) });
    expect(stale.isError).toBe(true);
    expect(stale.data.current_content).toBe("v1\n");
    const ok = await call("create_note", { path: "n.md", content: "v2\n", overwrite: true, if_match: data.etag });
    expect(ok.data).toMatchObject({ created: false });
    expect(await read("n.md")).toBe("v2\n");
  });

  it("requires overwrite when if_match is given", async () => {
    const res = await call("create_note", { path: "new.md", content: "x", if_match: "abc" });
    expect(res.text).toMatch(/pass overwrite: true/);
  });

  it("creates new notes and returns the etag", async () => {
    const res = await call("create_note", { path: `${ROOT}/Extras/New.md`, content: "# New\n" });
    expect(res.data).toMatchObject({ path: `${ROOT}/Extras/New.md`, created: true });
    expect(res.data.etag).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("update_note", () => {
  // Regression: '---' in replacement content truncated the write (end to end).
  it("writes content containing --- and tables in full", async () => {
    await put("s.md", SESSION_TEMPLATE);
    const content = "| Element | What Happened |\n|---|---|\n| Head | Burned |\n\n---\n\nAfter the divider.";
    const res = await call("update_note", { path: "s.md", mode: "replace_section", target: "What Actually Happened", content });
    expect(res.isError).toBe(false);
    const out = (await read("s.md"))!;
    expect(out).toContain(content);
    expect(out).toContain("## GM Reflection");
    expect(out.length).toBeGreaterThan(SESSION_TEMPLATE.length - 100);
  });

  // Regression: replace_section on a '#' heading wiped everything below it (end to end).
  it("replace_section on a # heading keeps later sections", async () => {
    await put("s.md", SESSION_TEMPLATE);
    await call("update_note", { path: "s.md", mode: "replace_section", target: "PART ONE — PREP", content: "Prep." });
    const out = (await read("s.md"))!;
    expect(out).toContain("# PART TWO — CHRONICLE");
    expect(out).toContain("## GM Reflection");
  });

  // Regression: missing heading / empty file were silent no-ops.
  it("reports a missing heading with the heading list and leaves the note alone", async () => {
    await put("s.md", SESSION_TEMPLATE);
    const res = await call("update_note", { path: "s.md", mode: "replace_section", target: "Session Log", content: "x" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not found[\s\S]*## The Goal/);
    expect(await read("s.md")).toBe(SESSION_TEMPLATE);
  });

  it("works on empty files with append, errors with section modes", async () => {
    await put("e.md", "");
    expect((await call("update_note", { path: "e.md", mode: "append_section", target: "X", content: "y" })).text).toMatch(/no headings/);
    await call("update_note", { path: "e.md", mode: "append", content: "## Log\n\nfirst" });
    expect(await read("e.md")).toBe("## Log\n\nfirst\n");
  });

  it("rejects paths outside the vault and non-markdown files", async () => {
    for (const path of ["../secret.md", "a/../../b.md", "C:/Users/x.md", "notes.txt"]) {
      const res = await call("update_note", { path, mode: "append", content: "x" });
      expect(res.isError, path).toBe(true);
    }
  });

  it("errors when the note doesn't exist", async () => {
    const res = await call("update_note", { path: "nope.md", mode: "append", content: "x" });
    expect(res.text).toMatch(/not found.*create_note/);
  });
});

describe("set_frontmatter_key", () => {
  const jackson = "---\ntags:\n  - npc\nstatus: active\nfirst_appeared: '[[Session 1 - Sweat Lodge]]'\naliases: Jackson Green\n---\n\n# 🎭 Jackson Green\n";

  it("sets a key and keeps the rest of the note byte-for-byte", async () => {
    await put("j.md", jackson);
    const { data } = await call("get_note", { path: "j.md" });
    const res = await call("set_frontmatter_key", { path: "j.md", key: "last_seen", value: "[[Session 4]]", if_match: data.etag });
    expect(res.data.frontmatter.last_seen).toBe("[[Session 4]]");
    expect(await read("j.md")).toBe(jackson.replace("aliases: Jackson Green\n", 'aliases: Jackson Green\nlast_seen: "[[Session 4]]"\n'));
  });

  it("writes arrays as lists and deletes with null", async () => {
    await put("j.md", jackson);
    await call("set_frontmatter_key", { path: "j.md", key: "aliases", value: ["Jackson Green", "[[Jackson]]"] });
    expect(await read("j.md")).toContain('aliases:\n  - Jackson Green\n  - "[[Jackson]]"\n---');
    await call("set_frontmatter_key", { path: "j.md", key: "aliases", value: null });
    expect(await read("j.md")).not.toContain("aliases");
  });

  it("creates frontmatter on a note without any", async () => {
    await put("p.md", "# Plain\n\nBody\n");
    await call("set_frontmatter_key", { path: "p.md", key: "status", value: "active" });
    expect(await read("p.md")).toBe("---\nstatus: active\n---\n\n# Plain\n\nBody\n");
  });

  // Regression: doubled YAML blocks.
  it("refuses to write when the body has a second YAML block", async () => {
    const nina = "---\ntags:\nstatus: active\n---\n---\ntags:\n  - npc\nstatus: active\n---\n\n# Nina\n";
    await put("nina.md", nina);
    const res = await call("set_frontmatter_key", { path: "nina.md", key: "status", value: "resolved" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/two YAML blocks/);
    expect(await read("nina.md")).toBe(nina);
  });

  it("refuses when key: value lines sit at the top of a note with no frontmatter", async () => {
    const text = "tags: npc\nstatus: active\n\n# Nina\n";
    await put("nina.md", text);
    const res = await call("set_frontmatter_key", { path: "nina.md", key: "status", value: "resolved" });
    expect(res.isError).toBe(true);
    expect(await read("nina.md")).toBe(text);
  });

  it("refuses an unterminated frontmatter block", async () => {
    await put("u.md", "---\ntags: x\n\n# T\n");
    const res = await call("set_frontmatter_key", { path: "u.md", key: "a", value: 1 });
    expect(res.text).toMatch(/never closed/);
  });
});

describe("create_session_from_template", () => {
  beforeEach(async () => {
    await put("Templates/Session.md.md", SESSION_TEMPLATE);
  });

  it("creates a filled-in session note", async () => {
    const res = await call("create_session_from_template", { session_number: 5, title: "Into the Roost", date: "Dec 6, 2026" });
    expect(res.isError).toBe(false);
    expect(res.data.path).toBe(`${ROOT}/Session Notes/Session 5 - Into the Roost.md`);
    const out = (await read(res.data.path))!;
    expect(out).toContain("session: 5\ntitle: Into the Roost\nreal_date: Dec 6, 2026\n");
    expect(out).toContain("# 📋 Session 5 — Into the Roost\n");
    expect(out).toContain("> **Real Date:** Dec 6, 2026\n");
    expect(out).not.toContain("{{");
    expect(out).toContain("# PART TWO — CHRONICLE");
  });

  it("omits the title cleanly when none is given", async () => {
    const res = await call("create_session_from_template", { session_number: 6 });
    expect(res.data.path).toBe(`${ROOT}/Session Notes/Session 6.md`);
    const out = (await read(res.data.path))!;
    expect(out).toContain("# 📋 Session 6\n");
    expect(out).toContain('title: ""');
  });

  it("strips characters Obsidian can't use in file names", async () => {
    const res = await call("create_session_from_template", { session_number: 7, title: 'What/Was "That"?' });
    expect(res.data.path).toBe(`${ROOT}/Session Notes/Session 7 - WhatWas That.md`);
  });

  it("refuses when that session number exists in either folder", async () => {
    await put("Session Notes/Session 5 - Old.md", "x");
    const res = await call("create_session_from_template", { session_number: 5, title: "New" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/already exists: Session Notes\/Session 5 - Old.md/);
    expect(await VAULT.head(`${ROOT}/Session Notes/Session 5 - New.md`)).toBeNull();
  });

  it("falls back to Session.md and to a 'date' key", async () => {
    await VAULT.delete("Templates/Session.md.md");
    await put("Templates/Session.md", "---\nsession: 0\ndate: \"\"\n---\n\n# Session {{NUMBER}} — {{TITLE}}\n");
    const res = await call("create_session_from_template", { session_number: 8, date: "Jan 1" });
    expect(await read(res.data.path)).toBe("---\nsession: 8\ndate: Jan 1\n---\n\n# Session 8\n");
  });

  it("errors when no template exists", async () => {
    await VAULT.delete("Templates/Session.md.md");
    expect((await call("create_session_from_template", { session_number: 9 })).text).toMatch(/template not found/);
  });
});

describe("get_campaign_state", () => {
  it("summarises the campaign and flags problems", async () => {
    await put(`${ROOT}/Dashboard.md`, "---\ncurrent_session: 3\n---\n\n# Dashboard\n");
    await put(
      `${ROOT}/TODO.md`,
      "# TODO\n\n## Vault Housekeeping\n\n- [ ] Fix Nina.md\n- [x] Done thing\n\n## Session Prep\n\n- [ ] Pick a crossroads\n",
    );
    await put("Session Notes/Session 1 - Sweat Lodge.md", "---\nsession: 1\nstatus: done\n---\n\n# Session 1\n");
    await put("Session Notes/Session 4 -.md", "---\nsession: 4\n---\n\n# 📋 Session 4 — \n");
    await put(`${ROOT}/Session Notes/Session 4.md`, "---\nsession: 4\ntitle: The Head Rolls at Midnight\nstatus: prep\n---\n\n# Session 4\n\nLots of prep here.\n");
    await put(`${ROOT}/Player Wildcards/Willie Greenhorn.md`, "---\nplayer: Sara\nrank: Novice\n---\n\n# 🎓 {{CHARACTER NAME}}\n");
    await put(`${ROOT}/Plots/Cool Voodoo.md`, "---\nstatus: active\n---\n\n# 🧵 Cool Voodoo\n");
    await put(`${ROOT}/NPC Wildcards/Nina.md`, "---\nstatus: active\n---\n\n# 🎭 Nina\n");

    const { data } = await call("get_campaign_state");
    expect(data.dashboard.frontmatter.current_session).toBe(3);
    expect(data.todo.open_items).toEqual([
      { section: "Vault Housekeeping", item: "Fix Nina.md" },
      { section: "Session Prep", item: "Pick a crossroads" },
    ]);
    expect(data.latest_session).toMatchObject({ path: `${ROOT}/Session Notes/Session 4.md`, number: 4, title: "The Head Rolls at Midnight" });
    expect(data.latest_session.content).toContain("Lots of prep here.");
    expect(data.sessions.map((s: any) => s.number)).toEqual([1, 4, 4]);
    expect(data.player_wildcards[0]).toMatchObject({ title: "🎓 {{CHARACTER NAME}}", frontmatter: { player: "Sara" } });
    expect(data.plots[0].frontmatter.status).toBe("active");
    expect(data.npc_wildcards[0].title).toBe("🎭 Nina");
    const w = data.warnings.join("\n");
    expect(w).toMatch(/Duplicate notes for session 4/);
    expect(w).toMatch(/Dashboard current_session is 3; the newest session note is 4/);
    expect(w).toMatch(/Willie Greenhorn.md: has unfilled template placeholders/);
  });

  it("copes with an empty vault", async () => {
    const { data, isError } = await call("get_campaign_state");
    expect(isError).toBe(false);
    expect(data.latest_session).toBeNull();
    expect(data.warnings).toEqual(expect.arrayContaining([`${ROOT}/Dashboard.md not found`]));
  });
});
