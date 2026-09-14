const units = ["B", "KB", "MB", "GB", "TB", "PB"];

// Decimal storage units; keep the number formatting consistent with the browser's locale.
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (Math.round(value * 10) / 10 >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}
