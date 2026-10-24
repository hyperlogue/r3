import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";

const records = ["daemon.json", "daemon.lock", "worker.json", "worker.json.lock"];
const hasRecords = (directory: string) => records.some((name) => existsSync(join(directory, name)));

// The caller pins this choice for its lifetime and passes it to spawned children.
// Never create or repair an implicit system directory: it must already be private.
export function resolveRuntimeDirectory(options: {
  state: string;
  runtime?: string;
  system?: string;
  uid?: number;
}): string {
  if (options.runtime?.trim()) return join(options.runtime.trim(), "r3");
  if (options.system && options.uid !== undefined) {
    try {
      const stat = lstatSync(options.system);
      if (stat.isDirectory() && stat.uid === options.uid && (stat.mode & 0o777) === 0o700) {
        const directory = join(options.system, "r3");
        // Older releases used state when the variable was absent. Keep those
        // servers/workers manageable, but prefer an existing system runtime.
        if (hasRecords(directory) || !hasRecords(options.state)) return directory;
      }
    } catch {
      /* No usable OS runtime directory; retain the portable state fallback. */
    }
  }
  return options.state;
}
