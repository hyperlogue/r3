import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRuntimeDirectory } from "./runtime-directory.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "r3-runtime-directory-"));
  const state = join(root, "state");
  const system = join(root, "system");
  mkdirSync(state, { mode: 0o700 });
  mkdirSync(system, { mode: 0o700 });
  return { root, state, system, uid: process.getuid?.() };
}

test("terminals with missing, blank and explicit system runtime share discovery and locks", () => {
  const f = fixture();
  try {
    for (const runtime of [undefined, "", "  ", f.system]) {
      expect(resolveRuntimeDirectory({ ...f, runtime })).toBe(join(f.system, "r3"));
    }
    const custom = join(f.root, "custom");
    expect(resolveRuntimeDirectory({ ...f, runtime: custom })).toBe(join(custom, "r3"));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("implicit runtime must be a private owned directory; otherwise use state", () => {
  const f = fixture();
  try {
    expect(resolveRuntimeDirectory({ ...f, system: undefined })).toBe(f.state);
    expect(resolveRuntimeDirectory({ ...f, system: join(f.root, "missing") })).toBe(f.state);
    expect(resolveRuntimeDirectory({ ...f, uid: undefined })).toBe(f.state);
    if (f.uid !== undefined)
      expect(resolveRuntimeDirectory({ ...f, uid: f.uid + 1 })).toBe(f.state);
    for (const mode of [0o755, 0o770, 0o777]) {
      chmodSync(f.system, mode);
      expect(resolveRuntimeDirectory(f)).toBe(f.state);
    }
    chmodSync(f.system, 0o700);
    const link = join(f.root, "link");
    symlinkSync(f.system, link);
    expect(resolveRuntimeDirectory({ ...f, system: link })).toBe(f.state);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("retain legacy state-directory discovery until its server and worker records are removed", () => {
  const f = fixture();
  try {
    for (const name of ["daemon.json", "daemon.lock", "worker.json", "worker.json.lock"]) {
      const record = join(f.state, name);
      writeFileSync(record, "legacy record");
      expect(resolveRuntimeDirectory(f)).toBe(f.state);
      expect(resolveRuntimeDirectory({ ...f, runtime: f.system })).toBe(join(f.system, "r3"));
      rmSync(record);
    }
    expect(resolveRuntimeDirectory(f)).toBe(join(f.system, "r3"));
    mkdirSync(join(f.system, "r3"));
    writeFileSync(join(f.system, "r3", "daemon.lock"), "existing server");
    writeFileSync(join(f.state, "daemon.json"), "older record");
    expect(resolveRuntimeDirectory(f)).toBe(join(f.system, "r3"));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
