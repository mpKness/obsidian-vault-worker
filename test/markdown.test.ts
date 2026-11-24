import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import {
  applyEdit,
  findSection,
  headings,
  parse,
  serialize,
  setFrontmatterKey,
  strayFrontmatter,
} from "../src/markdown";
// Loaded as text by Vite.
import SESSION_TEMPLATE from "./fixtures/Session.md.md?raw";

const edit = (text: string, mode: Parameters<typeof applyEdit>[1], content: string, target?: string) => {
  const doc = parse(text);
  return serialize({ ...doc, body: applyEdit(doc.body, mode, content, target).body });
};

describe("parse / serialize", () => {
  it("round-trips the session template unchanged", () => {
    expect(serialize(parse(SESSION_TEMPLATE))).toBe(SESSION_TEMPLATE);
  });

  it("only treats --- on line 1 as frontmatter", () => {
    const doc = parse("# Title\n\n---\n\nkey: value\n---\n");
    expect(doc.frontmatter).toBeNull();
    expect(doc.body[0]).toBe("# Title");
  });

  it("treats an unterminated opening --- as body text", () => {
    const doc = parse("---\ntags: x\n# Title\n");
    expect(doc.frontmatter).toBeNull();
    expect(doc.body).toEqual(["---", "tags: x", "# Title"]);
  });

  it("keeps a BOM and CRLF line endings", () => {
    const text = "﻿---\r\na: 1\r\n---\r\n\r\n# T\r\n";
    const doc = parse(text);
    expect(doc.eol).toBe("\r\n");
    expect(doc.frontmatter).toBe("a: 1");
    expect(serialize(doc)).toBe(text);
  });

  it("handles empty files", () => {
    const doc = parse("");
    expect(doc.body).toEqual([]);
    expect(serialize(doc)).toBe("");
  });
});

describe("headings", () => {
  it("ignores # lines inside code fences (``` and ~~~)", () => {
    const body = ["# Real", "```bash", "# not a heading", "```", "~~~~", "## also not", "```", "still fenced", "~~~~", "## Real 2"];
    expect(headings(body).map((h) => h.text)).toEqual(["Real", "Real 2"]);
  });

  it("strips closing #'s and ignores #hashtags", () => {
    expect(headings(["## Title ##", "#hashtag", "###### Six", "####### seven"]).map((h) => [h.level, h.text])).toEqual([
      [2, "Title"],
      [6, "Six"],
    ]);
  });

  it("never treats --- as a (setext) heading", () => {
    expect(headings(["Some text", "---", "More"]).length).toBe(0);
  });
});

describe("sections", () => {
  it("a # section includes its ## subsections and stops at the next #", () => {
    const body = parse(SESSION_TEMPLATE).body;
    const sec = findSection(body, "PART ONE — PREP");
    const inside = headings(body.slice(sec.start, sec.end)).map((h) => h.text);
    expect(inside).toEqual(["The Goal", "Scene Outline", "NPCs On Stage"]);
    expect(body[sec.end]).toBe("# PART TWO — CHRONICLE");
  });

  // Regression: replace_section on a '#' heading wiped everything below it.
  it("replace_section on a # heading leaves the following # sections intact", () => {
    const out = edit(SESSION_TEMPLATE, "replace_section", "Prep goes here.", "PART ONE — PREP");
    expect(out).toContain("# PART ONE — PREP\n\nPrep goes here.\n\n---\n\n# PART TWO — CHRONICLE");
    expect(out).toContain("## What Actually Happened");
    expect(out).toContain("## GM Reflection");
    expect(out).not.toContain("## The Goal");
    expect(out.startsWith("---\ntags:")).toBe(true);
  });

  it("replace_section on a ## heading keeps the divider and siblings", () => {
    const out = edit(SESSION_TEMPLATE, "replace_section", "Resolve Cool Voodoo.", "The Goal");
    expect(out).toContain("## The Goal\n\nResolve Cool Voodoo.\n\n---\n\n## Scene Outline");
    expect(out).toContain("*Loose beats in rough order.");
  });

  // Regression: '---' inside replacement content truncated the write.
  it("keeps --- and tables inside replacement content", () => {
    const content = "| A | B |\n|---|---|\n| 1 | 2 |\n\n---\n\n### Sub\n\nAfter the divider.";
    const out = edit(SESSION_TEMPLATE, "replace_section", content, "What Actually Happened");
    expect(out).toContain("## What Actually Happened\n\n" + content + "\n\n---\n\n## Loose Ends to Carry Forward");
    expect(out).toContain("## GM Reflection");
  });

  it("append_section on a # heading lands after its nested subsections", () => {
    const out = edit(SESSION_TEMPLATE, "append_section", "## Extra Prep\n\nNotes.", "PART ONE — PREP");
    const extra = out.indexOf("## Extra Prep");
    expect(extra).toBeGreaterThan(out.indexOf("## NPCs On Stage"));
    expect(extra).toBeLessThan(out.indexOf("# PART TWO — CHRONICLE"));
    expect(out).toContain("## Extra Prep\n\nNotes.\n\n---\n\n# PART TWO");
  });

  it("append_section adds to the end of a ## section", () => {
    const out = edit(SESSION_TEMPLATE, "append_section", "- [ ] Follow up with Bishop", "Loose Ends to Carry Forward");
    expect(out).toContain("- [ ] \n- [ ] \n\n- [ ] Follow up with Bishop\n\n---\n\n## GM Reflection");
  });

  it("works on the last section of the note", () => {
    const out = edit(SESSION_TEMPLATE, "replace_section", "It went well.", "GM Reflection");
    expect(out.endsWith("## GM Reflection\n\nIt went well.\n")).toBe(true);
  });

  it("replace_section with empty content leaves just the heading and divider", () => {
    const out = edit("## A\n\nold\n\n---\n\n## B\n", "replace_section", "", "A");
    expect(out).toBe("## A\n\n---\n\n## B\n");
  });

  // Regression: a missing heading was a silent no-op.
  it("errors with the heading list when the target is missing", () => {
    expect(() => edit(SESSION_TEMPLATE, "replace_section", "x", "Nope")).toThrow(/not found[\s\S]*## The Goal/);
  });

  it("errors on duplicate headings and lists them; #'s pick a level", () => {
    const text = "# Log\n\none\n\n## Log\n\ntwo\n\n## Log\n\nthree\n";
    expect(() => edit(text, "replace_section", "x", "Log")).toThrow(/ambiguous[\s\S]*lines 1, 5, 9/);
    expect(edit(text, "append_section", "x", "# Log")).toContain("three\n\nx\n");
    expect(() => edit(text, "replace_section", "x", "## Log")).toThrow(/ambiguous/);
  });

  // Regression: empty files caused a silent no-op.
  it("errors on section modes in an empty file, but append/prepend work", () => {
    expect(() => edit("", "replace_section", "x", "Anything")).toThrow(/no headings/);
    expect(() => edit("", "append_section", "x", "Anything")).toThrow(/no headings/);
    expect(edit("", "append", "First line.")).toBe("First line.\n");
    expect(edit("", "prepend", "First line.")).toBe("First line.\n");
  });

  it("prepend goes after frontmatter; append goes at the end", () => {
    const text = "---\na: 1\n---\n\n# Title\n\nBody\n";
    expect(edit(text, "prepend", "> note")).toBe("---\na: 1\n---\n\n> note\n\n# Title\n\nBody\n");
    expect(edit(text, "append", "Last.")).toBe("---\na: 1\n---\n\n# Title\n\nBody\n\nLast.\n");
  });

  it("keeps CRLF line endings when editing", () => {
    const text = "## A\r\n\r\nold\r\n\r\n## B\r\n\r\nkeep\r\n";
    expect(edit(text, "replace_section", "new\nlines", "A")).toBe("## A\r\n\r\nnew\r\nlines\r\n\r\n## B\r\n\r\nkeep\r\n");
  });

  it("does not split a section at # lines inside a code fence", () => {
    const text = "## Script\n\n```bash\n# comment\n## also comment\n```\n\n## Next\n\nx\n";
    const out = edit(text, "replace_section", "replaced", "Script");
    expect(out).toBe("## Script\n\nreplaced\n\n## Next\n\nx\n");
  });

  it("needs a target for section modes", () => {
    expect(() => edit("## A\n", "replace_section", "x")).toThrow(/needs a target/);
  });
});

describe("frontmatter", () => {
  const fm = 'tags:\n  - npc\n  - etucampaign\nstatus: active\nfirst_appeared: \'[[Session 1 - Sweat Lodge]]\'\nlast_seen: ""\nempty:\naliases: Jackson Green';

  // Regression: single-value aliases were written as quoted list strings.
  it("writes a single alias as a plain scalar and keeps the others untouched", () => {
    const out = setFrontmatterKey(fm, "aliases", "Jackson G.");
    expect(out).toBe(fm.replace("aliases: Jackson Green", "aliases: Jackson G."));
  });

  it("writes arrays as real YAML lists with quoted wikilinks", () => {
    const out = setFrontmatterKey(fm, "aliases", ["[[Willie Greenhorn]]", "Willie"]);
    expect(out).toContain('aliases:\n  - "[[Willie Greenhorn]]"\n  - Willie');
    expect(parseDocument(out).toJS().aliases).toEqual(["[[Willie Greenhorn]]", "Willie"]);
  });

  it("quotes a single wikilink correctly", () => {
    const out = setFrontmatterKey(fm, "last_seen", "[[Session 4]]");
    expect(parseDocument(out).toJS().last_seen).toBe("[[Session 4]]");
  });

  it("rejects list-looking strings", () => {
    expect(() => setFrontmatterKey(fm, "aliases", "['Jackson Green']")).toThrow(/JSON array/);
  });

  it("keeps key order, quoting and empty values; null deletes", () => {
    const out = setFrontmatterKey(fm, "status", "resolved");
    expect(out.split("\n").map((l) => l.split(":")[0])).toEqual(fm.split("\n").map((l) => l.split(":")[0]));
    expect(out).toContain("first_appeared: '[[Session 1 - Sweat Lodge]]'");
    expect(out).toContain("empty:\n");
    expect(setFrontmatterKey(fm, "empty", null)).not.toContain("empty:");
  });

  it("creates frontmatter when there is none", () => {
    expect(setFrontmatterKey(null, "status", "active")).toBe("status: active");
  });

  it("rejects invalid YAML", () => {
    expect(() => setFrontmatterKey("a: [unclosed", "b", 1)).toThrow(/valid YAML/);
  });

  // Regression: doubled YAML blocks.
  it("detects frontmatter-looking text in the body", () => {
    expect(strayFrontmatter(["", "---", "tags:", "  - npc", "status: active", "---", "", "# Nina"])).toMatch(/second '---' block/);
    expect(strayFrontmatter(["tags:", "status: active", "", "# Nina"])).toMatch(/frontmatter keys/);
    expect(strayFrontmatter(["", "# Nina", "", "---", "a: b", "---"])).toBeNull();
    expect(strayFrontmatter(["Note: one line of prose", "", "# T"])).toBeNull();
    expect(strayFrontmatter(["---", "", "Just a divider", "---"])).toBeNull();
  });
});
