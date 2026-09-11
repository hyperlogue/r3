// Git quotes unusual paths with C escapes, including octal UTF-8 bytes.
// Spaces alone are unquoted; ---/+++ append a tab to disambiguate them.
export function decodeGitPath(value: string, fileHeader = false): string {
  if (value.length > 65_536) return value;
  if (!value.startsWith('"')) return fileHeader ? value.split("\t", 1)[0] : value;
  const match = /^"((?:\\.|[^"\\])*)"/.exec(value);
  if (!match) return value;
  const bytes: number[] = [];
  const escapes: Record<string, number> = {
    a: 7,
    b: 8,
    t: 9,
    n: 10,
    v: 11,
    f: 12,
    r: 13,
    '"': 34,
    "\\": 92,
  };
  const pieces = match[1].match(/\\[0-7]{1,3}|\\.|[^\\]+/g) ?? [];
  for (const piece of pieces) {
    if (/^\\[0-7]{1,3}$/.test(piece)) bytes.push(Number.parseInt(piece.slice(1), 8));
    else if (piece.startsWith("\\") && piece.slice(1) in escapes)
      bytes.push(escapes[piece.slice(1)]);
    else for (const byte of Buffer.from(piece)) bytes.push(byte);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return value;
  }
}

export function gitHeaderPaths(header: string): [string, string] | null {
  if (header.length > 131_072) return null;
  const input = header.slice("diff --git ".length);
  // Unquoted names may themselves contain " b/". Equal paths disambiguate a
  // modification; rename headers supply the authoritative two names otherwise.
  const middle = Math.floor(input.length / 2);
  const first = decodeGitPath(input.slice(0, middle));
  const second = decodeGitPath(input.slice(middle + 1));
  if (
    input[middle] === " " &&
    first.startsWith("a/") &&
    second.startsWith("b/") &&
    first.slice(2) === second.slice(2)
  )
    return [first.slice(2), second.slice(2)];
  const match = /^("(?:\\.|[^"\\])*"|a\/.*) ("(?:\\.|[^"\\])*"|b\/.*)$/.exec(input);
  if (!match) return null;
  const oldPath = decodeGitPath(match[1]);
  const newPath = decodeGitPath(match[2]);
  return oldPath.startsWith("a/") && newPath.startsWith("b/")
    ? [oldPath.slice(2), newPath.slice(2)]
    : null;
}
