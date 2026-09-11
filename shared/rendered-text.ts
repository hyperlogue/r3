// DOM selection, locator capture and locator matching use the same whitespace
// rule. This describes visible text; it never maps rendered offsets to source.
export function normalizeRenderedText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
