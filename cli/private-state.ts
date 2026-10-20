import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("Private state needs an owned directory");
  chmodSync(path, 0o700);
}

export function readPrivateJson<T>(path: string): T | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || (process.getuid && stat.uid !== process.getuid()) || stat.mode & 0o077)
      throw new Error("Private state must be an owner-only regular file");
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Cannot read private r3 state; check its format and permissions");
  }
}

export function writePrivateJson(path: string, value: unknown): void {
  privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(value)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  syncDirectory(dirname(path));
}

function syncDirectory(path: string): void {
  const directory = openSync(path, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

export function removePrivateJson(path: string): void {
  rmSync(path, { force: true });
  syncDirectory(dirname(path));
}

// Call only while holding the owning writer's lock, before it starts writing.
export function cleanupPrivateTemps(
  directory: string,
  acceptsBase: (name: string) => boolean,
): void {
  let removed = false;
  for (const name of readdirSync(directory)) {
    const match = /^(.*)\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.exec(
      name,
    );
    if (!match || !acceptsBase(basename(match[1]!))) continue;
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (stat.isFile() && (!process.getuid || stat.uid === process.getuid())) {
      rmSync(path);
      removed = true;
    }
  }
  if (removed) syncDirectory(directory);
}

export async function withPrivateLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  privateDirectory(dirname(path));
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const fd = openSync(path, "wx", 0o600);
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = Number(readFileSync(path, "utf8"));
        if (Number.isInteger(owner) && owner > 0) {
          try {
            process.kill(owner, 0);
          } catch (failure) {
            if ((failure as NodeJS.ErrnoException).code === "ESRCH") rmSync(path, { force: true });
          }
        } else if (Date.now() - lstatSync(path).mtimeMs > 5000) rmSync(path, { force: true });
      } catch {
        /* The competing process released its lock. */
      }
      if (Date.now() >= deadline) throw new Error("r3 state is busy; retry the command");
      await Bun.sleep(25);
    }
  }
  try {
    return await action();
  } finally {
    rmSync(path, { force: true });
  }
}
