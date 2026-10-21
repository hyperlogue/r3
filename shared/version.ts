// Shared by daemon + CLI. Bump on any wire-format or daemon-protocol change.
export const R3_VERSION = "2.3.0";

export const R3_VERSION_HEADER = "X-R3-Version";

function parseVersion(value: string): string[] | null {
  if (value.length > 128) return null;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (!match || match[0] !== value || match[4]?.split(".").some((part) => /^0\d+$/.test(part)))
    return null;
  return match.slice(1);
}

const compareNumber = (left: string, right: string): number =>
  left.length !== right.length
    ? Math.sign(left.length - right.length)
    : left === right
      ? 0
      : left < right
        ? -1
        : 1;

// Release precedence, not lexical ordering. Build metadata has no precedence;
// non-release fixture/development labels remain explicitly unordered.
export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) {
    const order = compareNumber(a[index], b[index]);
    if (order) return order;
  }
  if (!a[3] || !b[3]) return a[3] === b[3] ? 0 : a[3] ? -1 : 1;
  const prereleaseA = a[3].split(".");
  const prereleaseB = b[3].split(".");
  for (let index = 0; index < Math.max(prereleaseA.length, prereleaseB.length); index++) {
    const x = prereleaseA[index];
    const y = prereleaseB[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const numericX = /^\d+$/.test(x);
    const numericY = /^\d+$/.test(y);
    if (numericX && numericY) return compareNumber(x, y);
    if (numericX !== numericY) return numericX ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
