// Markdown helpers for section-level edits and frontmatter.
//
// Rules (these are what the old local server got wrong, so they're deliberate):
// - Frontmatter exists only when line 1 is exactly `---` and a later line is
//   `---` (or `...`). A `---` anywhere else is ordinary content (a divider).
// - Headings are ATX headings (`#` to `######` followed by a space or end of
//   line). Lines inside ``` or ~~~ code fences are never headings. Setext
//   headings (text underlined with ===/---) are not recognised; that keeps
//   `---` dividers from ever being mistaken for headings.
// - A section is a heading plus everything until the next heading of the same
//   or a higher level (fewer #'s). Nested subheadings belong to the section.
// - Edits preserve the file's line endings (LF or CRLF) and a leading BOM.

import { Document, isMap, parseDocument } from "yaml";

export class MarkdownError extends Error {}

export interface Heading {
  level: number;
  text: string;
  /** Index into Parsed.body. */
  index: number;
}

export interface Parsed {
  bom: string;
  eol: "\n" | "\r\n";
  /** Raw YAML between the fences, or null when there is no frontmatter. */
  frontmatter: string | null;
  body: string[];
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const KEY_VALUE = /^[A-Za-z_][\w -]*:(?:\s|$)/;
const LIST_ITEM = /^\s+-\s/;

export function parse(text: string): Parsed {
  let bom = "";
  if (text.startsWith("﻿")) {
    bom = "﻿";
    text = text.slice(1);
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // A trailing newline produces one empty final element; drop it so the body
  // is just the content lines. serialize() always ends with a newline.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  if (lines.length > 0 && lines[0].trimEnd() === "---") {
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i].trimEnd();
      if (l === "---" || l === "...") {
        return { bom, eol, frontmatter: lines.slice(1, i).join("\n"), body: lines.slice(i + 1) };
      }
    }
  }
  return { bom, eol, frontmatter: null, body: lines };
}

export function serialize(doc: Parsed): string {
  const out: string[] = [];
  if (doc.frontmatter !== null) {
    out.push("---");
    if (doc.frontmatter !== "") out.push(...doc.frontmatter.replace(/\n+$/, "").split("\n"));
    out.push("---");
  }
  out.push(...doc.body);
  const text = out.length ? out.join("\n") + "\n" : "";
  return doc.bom + (doc.eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text);
}

/** Split caller-supplied content into lines, normalising line endings and trimming outer blank lines. */
export function contentLines(content: string): string[] {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines;
}

export function headings(body: string[]): Heading[] {
  const out: Heading[] = [];
  let fence: { char: string; len: number } | null = null;
  body.forEach((line, index) => {
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
      return;
    }
    const open = line.match(FENCE_OPEN);
    if (open) {
      fence = { char: open[1][0], len: open[1].length };
      return;
    }
    const m = line.match(HEADING);
    if (!m) return;
    const text = (m[2] ?? "").replace(/[ \t]+#+$/, "").replace(/^#+$/, "").trim();
    out.push({ level: m[1].length, text, index });
  });
  return out;
}

function describeHeadings(hs: Heading[]): string {
  if (hs.length === 0) return "The note has no headings.";
  return "Headings found:\n" + hs.map((h) => `  line ${h.index + 1}: ${"#".repeat(h.level)} ${h.text}`).join("\n");
}

export interface Section {
  heading: Heading;
  /** Index of the first line after the heading. */
  start: number;
  /** Index one past the section's last line. */
  end: number;
  /**
   * Index where the section's trailer starts: trailing blank lines plus at most
   * one closing divider (`---`). Edits keep the trailer so dividers between
   * sections survive. Equal to `end` when there's no trailer.
   */
  trailerStart: number;
}

/**
 * Find the section for `target`. `target` is the heading text exactly as
 * written (without the #'s). It may also include the #'s ("## Session Log") to
 * pick a specific level when the same text appears at different levels.
 */
export function findSection(body: string[], target: string): Section {
  const hs = headings(body);
  const t = target.trim();
  const levelMatch = t.match(/^(#{1,6})[ \t]+(.*)$/);
  const wantLevel = levelMatch ? levelMatch[1].length : undefined;
  const wantText = (levelMatch ? levelMatch[2] : t).trim();
  if (!wantText) throw new MarkdownError("target heading is empty. " + describeHeadings(hs));

  const matches = hs.filter((h) => h.text === wantText && (wantLevel === undefined || h.level === wantLevel));
  if (matches.length === 0) {
    throw new MarkdownError(`Heading "${t}" not found. ${describeHeadings(hs)}`);
  }
  if (matches.length > 1) {
    throw new MarkdownError(
      `Heading "${t}" is ambiguous: it appears ${matches.length} times (lines ${matches
        .map((h) => h.index + 1)
        .join(", ")}). Rename one in Obsidian, or include the #'s to pick a level if they differ. ${describeHeadings(hs)}`,
    );
  }
  const heading = matches[0];
  const next = hs.find((h) => h.index > heading.index && h.level <= heading.level);
  const end = next ? next.index : body.length;
  const start = heading.index + 1;

  let trailerStart = end;
  while (trailerStart > start && body[trailerStart - 1].trim() === "") trailerStart--;
  if (trailerStart > start && THEMATIC_BREAK.test(body[trailerStart - 1])) {
    trailerStart--;
    while (trailerStart > start && body[trailerStart - 1].trim() === "") trailerStart--;
  }
  return { heading, start, end, trailerStart };
}

/** Normalise a trailer so it starts with a blank line (when non-empty) and keeps separation from the next heading. */
function trailerFor(body: string[], sec: Section): string[] {
  const trailer = body.slice(sec.trailerStart, sec.end);
  const hasMore = sec.end < body.length;
  const meaningful = trailer.some((l) => l.trim() !== "");
  if (!meaningful) return hasMore ? [""] : [];
  const core = trailer.filter((l, i) => !(l.trim() === "" && (i === 0 || i === trailer.length - 1)));
  return hasMore ? ["", ...core, ""] : ["", ...core];
}

export type EditMode = "replace_section" | "append_section" | "prepend" | "append";

export interface EditResult {
  body: string[];
  /** Lines removed and added, for a short diff. */
  removed: string[];
  added: string[];
  /** 1-based line in the body where the change starts. */
  at: number;
}

export function applyEdit(body: string[], mode: EditMode, content: string, target?: string): EditResult {
  const lines = contentLines(content);

  if (mode === "prepend") {
    let rest = body.slice();
    while (rest.length && rest[0].trim() === "") rest.shift();
    const added = lines.length ? (rest.length ? [...lines, ""] : lines) : [];
    // Keep one blank line between the frontmatter and the content, as Obsidian does.
    const lead = body.length && body[0].trim() === "" ? [""] : [];
    return { body: [...lead, ...added, ...rest], removed: [], added: lines, at: lead.length + 1 };
  }

  if (mode === "append") {
    const core = body.slice();
    while (core.length && core[core.length - 1].trim() === "") core.pop();
    const sep = core.length && lines.length ? [""] : [];
    return { body: [...core, ...sep, ...lines], removed: [], added: lines, at: core.length + sep.length + 1 };
  }

  if (!target) throw new MarkdownError(`mode "${mode}" needs a target heading. ${describeHeadings(headings(body))}`);
  const sec = findSection(body, target);
  const headingLine = body[sec.heading.index];
  const before = body.slice(0, sec.heading.index);
  const after = body.slice(sec.end);
  const trailer = trailerFor(body, sec);

  if (mode === "replace_section") {
    const removed = body.slice(sec.start, sec.trailerStart);
    const inner = lines.length ? ["", ...lines] : [];
    return {
      body: [...before, headingLine, ...inner, ...trailer, ...after],
      removed: removed.filter((l, i, a) => !(l.trim() === "" && (i === 0 || i === a.length - 1))),
      added: lines,
      at: sec.heading.index + 2,
    };
  }

  if (mode === "append_section") {
    const core = body.slice(sec.start, sec.trailerStart);
    while (core.length && core[0].trim() === "") core.shift();
    const inner = core.length ? ["", ...core, "", ...lines] : ["", ...lines];
    return {
      body: [...before, headingLine, ...(lines.length ? inner : core.length ? ["", ...core] : []), ...trailer, ...after],
      removed: [],
      added: lines,
      at: sec.heading.index + 1 + inner.length - lines.length + 1,
    };
  }

  throw new MarkdownError(`unknown mode "${mode}"`);
}

/** A short unified-style diff of an edit, capped so tool output stays small. */
export function summarizeEdit(r: EditResult, max = 12): string {
  const cap = (ls: string[], sign: string) =>
    ls.length > max ? [...ls.slice(0, max).map((l) => sign + l), `${sign}… (${ls.length - max} more lines)`] : ls.map((l) => sign + l);
  const head = `@@ body line ${r.at}: -${r.removed.length} +${r.added.length} @@`;
  return [head, ...cap(r.removed, "-"), ...cap(r.added, "+")].join("\n");
}

// ---------------------------------------------------------------------------
// Frontmatter

/**
 * Look for frontmatter-like text in the body: a `---` block of key/value lines,
 * or key/value lines right at the top. Returns a description, or null.
 */
export function strayFrontmatter(body: string[]): string | null {
  let i = 0;
  while (i < body.length && body[i].trim() === "") i++;
  if (i >= body.length) return null;

  if (body[i].trimEnd() === "---") {
    let j = i + 1;
    let keys = 0;
    while (j < body.length && body[j].trimEnd() !== "---") {
      if (KEY_VALUE.test(body[j])) keys++;
      else if (!LIST_ITEM.test(body[j]) && body[j].trim() !== "") break;
      j++;
    }
    if (j < body.length && body[j].trimEnd() === "---" && keys > 0) {
      return `body lines ${i + 1}-${j + 1} hold a second '---' block of YAML-looking keys`;
    }
    return null;
  }

  let j = i;
  let keys = 0;
  while (j < body.length && (KEY_VALUE.test(body[j]) || (keys > 0 && LIST_ITEM.test(body[j])))) {
    if (KEY_VALUE.test(body[j])) keys++;
    j++;
  }
  if (keys >= 2) return `body lines ${i + 1}-${j} look like frontmatter keys written as plain text`;
  return null;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue };

const STRINGIFY = { lineWidth: 0, nullStr: "" } as const;

export function parseFrontmatter(raw: string | null): Document {
  const doc = parseDocument(raw ?? "", { keepSourceTokens: false });
  if (doc.errors.length) {
    throw new MarkdownError(`frontmatter isn't valid YAML: ${doc.errors[0].message.split("\n")[0]}`);
  }
  if (doc.contents !== null && !isMap(doc.contents)) {
    throw new MarkdownError("frontmatter isn't a YAML mapping of keys to values");
  }
  return doc;
}

export function frontmatterObject(raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const v = parseFrontmatter(raw).toJS();
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A string that looks like a YAML/JSON list but isn't a wikilink: probably meant as an array. */
function looksLikeListString(v: string): boolean {
  const t = v.trim();
  return t.startsWith("[") && t.endsWith("]") && !/^\[\[[^\]]*\]\]$/.test(t);
}

/**
 * Set (or with null, delete) one key, keeping other keys, their order,
 * comments and quoting. Returns the new raw YAML.
 */
export function setFrontmatterKey(raw: string | null, key: string, value: JsonValue): string {
  if (!key.trim()) throw new MarkdownError("key is empty");
  if (typeof value === "string" && looksLikeListString(value)) {
    throw new MarkdownError(
      `value ${JSON.stringify(value)} looks like a list written as a string. Pass a JSON array (e.g. ["a", "b"]) for a list, or a plain string for a single value.`,
    );
  }
  const doc = parseFrontmatter(raw);
  if (value === null) {
    if (doc.contents) doc.delete(key);
  } else if (doc.contents) {
    doc.set(key, doc.createNode(value));
  } else {
    doc.contents = doc.createNode({ [key]: value }) as any;
  }
  return doc.contents && isMap(doc.contents) && doc.contents.items.length
    ? doc.toString(STRINGIFY).replace(/\n+$/, "")
    : "";
}
