// Depth-first tree order: directories before files, alphabetically within each
// group. Use the same sibling comparison in the file panel and the content stack.
export function compareFilePaths(left: string, right: string): number {
  const a = left.split("/");
  const b = right.split("/");
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const aDirectory = i < a.length - 1;
    const bDirectory = i < b.length - 1;
    if (aDirectory !== bDirectory) return aDirectory ? -1 : 1;
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}
