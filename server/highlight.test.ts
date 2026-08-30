import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThemedToken } from "shiki";

// db.ts opens its singleton at import time. Point it at an isolated store before
// dynamically importing the module under test so tests never touch the user's
// real r3 state or persisted config.
const testRoot = mkdtempSync(join(tmpdir(), "r3-highlight-test-"));
process.env.R3_DB = join(testRoot, "r3.sqlite");
process.env.XDG_CONFIG_HOME = join(testRoot, "config");

const { tokensToLineHtml } = await import("./highlight.ts");

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

// A stand-in for a resolved theme's palette: two indexed colours per slot, plus
// the default foreground each slot's tokens inherit from `.shiki-surface`.
const PAL = {
  lightBg: "#FFFFFF",
  darkBg: "#24292E",
  lightFg: "#24292E",
  darkFg: "#E1E4E8",
  light: new Map([
    ["#005cc5", 1],
    ["#032f62", 2],
  ]),
  dark: new Map([
    ["#79b8ff", 1],
    ["#9ecbff", 2],
  ]),
  css: "",
};

// Colours the palette above indexes, and one it doesn't (→ the `.sx` fallback).
const BLUE = { light: "#005CC5", dark: "#79B8FF" }; // sl1 sd1
const STR = { light: "#032F62", dark: "#9ECBFF" }; // sl2 sd2
const FG = { light: "#24292E", dark: "#E1E4E8" }; // the default foreground
const OFF = { light: "#ABCDEF", dark: "#123456" }; // outside the palette

function tok(
  content: string,
  color?: { light: string; dark: string },
  extra?: Record<string, string>,
): ThemedToken {
  const htmlStyle: Record<string, string> = {};
  if (color) {
    htmlStyle["--shiki-light"] = color.light;
    htmlStyle["--shiki-dark"] = color.dark;
  }
  return { content, offset: 0, htmlStyle: { ...htmlStyle, ...extra } };
}

describe("tokensToLineHtml", () => {
  test("a default-foreground token emits no wrapper at all", () => {
    expect(tokensToLineHtml([tok("const x = 1;", FG)], PAL)).toBe("const x = 1;");
  });

  test("a token with no colour at all is bare text too", () => {
    expect(tokensToLineHtml([tok("  ")], PAL)).toBe("  ");
  });

  test("an empty line stays empty", () => {
    expect(tokensToLineHtml([], PAL)).toBe("");
    expect(tokensToLineHtml([tok("", BLUE)], PAL)).toBe("");
  });

  test("adjacent tokens with the same classes merge into one span", () => {
    const line = [tok("con", BLUE), tok("st", BLUE)];
    expect(tokensToLineHtml(line, PAL)).toBe('<span class="sl1 sd1">const</span>');
  });

  test("different classes still get their own spans", () => {
    const line = [tok("const", BLUE), tok('"x"', STR)];
    expect(tokensToLineHtml(line, PAL)).toBe(
      '<span class="sl1 sd1">const</span><span class="sl2 sd2">&quot;x&quot;</span>',
    );
  });

  test("font style is part of the class string, so it splits a run", () => {
    const line = [tok("a", BLUE), tok("b", BLUE, { "--shiki-light-font-style": "italic" })];
    expect(tokensToLineHtml(line, PAL)).toBe(
      '<span class="sl1 sd1">a</span><span class="sl1 sli sd1">b</span>',
    );
  });

  test("a default-fg run between two coloured runs splits them, bare", () => {
    const line = [tok("a", BLUE), tok(" = ", FG), tok("b", BLUE)];
    expect(tokensToLineHtml(line, PAL)).toBe(
      '<span class="sl1 sd1">a</span> = <span class="sl1 sd1">b</span>',
    );
  });

  test("default-fg neighbours coalesce into one bare text run", () => {
    expect(tokensToLineHtml([tok("a", FG), tok(" "), tok("b", FG)], PAL)).toBe("a b");
  });

  test("a zero-length token never breaks a run in two", () => {
    const line = [tok("a", BLUE), tok("", STR), tok("b", BLUE)];
    expect(tokensToLineHtml(line, PAL)).toBe('<span class="sl1 sd1">ab</span>');
  });

  test("a colour outside the palette keeps the inline `.sx` fallback", () => {
    expect(tokensToLineHtml([tok("x", OFF)], PAL)).toBe(
      '<span class="sx" style="--shiki-light:#ABCDEF;--shiki-dark:#123456">x</span>',
    );
  });

  test("fallback tokens never merge, with each other or across a run", () => {
    const sx = (t: string): string =>
      `<span class="sx" style="--shiki-light:#ABCDEF;--shiki-dark:#123456">${t}</span>`;
    expect(tokensToLineHtml([tok("a", OFF), tok("b", OFF)], PAL)).toBe(`${sx("a")}${sx("b")}`);
    // The run on either side of a fallback is flushed, not carried across it.
    const line = [tok("a", BLUE), tok("!", OFF), tok("b", BLUE)];
    expect(tokensToLineHtml(line, PAL)).toBe(
      `<span class="sl1 sd1">a</span>${sx("!")}<span class="sl1 sd1">b</span>`,
    );
  });

  test("no palette → every token keeps the pre-palette shape", () => {
    expect(tokensToLineHtml([tok("a", BLUE), tok("b")], null)).toBe(
      '<span class="sx" style="--shiki-light:#005CC5;--shiki-dark:#79B8FF">a</span><span>b</span>',
    );
  });

  test("escaping applies, inside a span and bare", () => {
    expect(tokensToLineHtml([tok('a<b&c"d', BLUE)], PAL)).toBe(
      '<span class="sl1 sd1">a&lt;b&amp;c&quot;d</span>',
    );
    expect(tokensToLineHtml([tok("<a>", FG), tok("&b", FG)], PAL)).toBe("&lt;a&gt;&amp;b");
  });
});
