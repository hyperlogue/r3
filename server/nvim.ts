// Open-in-editor deep links. Walks parent processes to the nvim that
// launched us and drives it over its RPC socket, so
// clicking a `file:line` reference jumps the editor there. Disabled when there's
// no nvim ancestor.

import { existsSync, statSync } from "node:fs";
import { Glob } from "bun";

function procInfo(pid: number): { ppid: number; comm: string } | null {
  try {
    const out = Bun.spawnSync(["ps", "-o", "ppid=,comm=", "-p", String(pid)])
      .stdout.toString()
      .trim();
    const m = out.match(/^\s*(\d+)\s+(.*)$/);
    return m ? { ppid: Number(m[1]), comm: m[2].trim() } : null;
  } catch {
    return null;
  }
}

function ancestorNvimPids(): number[] {
  const pids: number[] = [];
  let pid = process.pid;
  let guard = 0;
  while (pid > 1 && guard++ < 40) {
    const info = procInfo(pid);
    if (!info) break;
    const base = (info.comm.split("/").pop() ?? "").split(" ")[0];
    if (base === "nvim") pids.push(pid);
    pid = info.ppid;
  }
  return pids;
}

function socketForPid(pid: number): string | null {
  const runRoot = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || "/tmp";
  const runDir = `${runRoot}/nvim.${process.env.USER ?? ""}`;
  try {
    for (const hit of new Glob(`*/nvim.${pid}.0`).scanSync({
      cwd: runDir,
      absolute: true,
      onlyFiles: false,
    }))
      return hit;
  } catch {}
  try {
    for (const line of Bun.spawnSync(["lsof", "-nP", "-a", "-p", String(pid), "-U", "-F", "n"])
      .stdout.toString()
      .split("\n")) {
      if (line.startsWith("n") && line.includes("/nvim.") && line.endsWith(".0"))
        return line.slice(1);
    }
  } catch {}
  return null;
}

function findNvimSocket(): string | null {
  if (process.env.R3_NVIM_SOCKET) return process.env.R3_NVIM_SOCKET;
  const ancestors = ancestorNvimPids();
  if (!ancestors.length) return null;
  if (process.env.NVIM && existsSync(process.env.NVIM)) return process.env.NVIM;
  for (const pid of ancestors) {
    const s = socketForPid(pid);
    if (s) return s;
  }
  return null;
}

let NVIM_SOCKET = findNvimSocket();
let lastDetect = 0;

export function nvimAvailable(): boolean {
  if (NVIM_SOCKET && existsSync(NVIM_SOCKET)) return true;
  const now = Date.now();
  if (now - lastDetect > 3000) {
    lastDetect = now;
    NVIM_SOCKET = findNvimSocket();
  }
  return !!(NVIM_SOCKET && existsSync(NVIM_SOCKET));
}

// `abs` is an absolute path the route already validated against the request's
// worktree (repo.safePath); we only confirm it's a real file before driving nvim.
// The path is interpolated into an nvim `--remote-send` keystroke string, which
// interprets `<...>` as key notation and spaces/`:` as argument/command breaks —
// so reject anything outside a conservative path charset (a repo file literally
// named e.g. `x<CR>:!touch /tmp/pwned<CR>.ts` would otherwise inject keystrokes).
export function openInNvim(abs: string, line: number | null): boolean {
  if (!nvimAvailable() || !NVIM_SOCKET) return false;
  if (!abs || abs.includes("..") || !/^[\w./@+-]+$/.test(abs)) return false;
  try {
    if (!statSync(abs).isFile()) return false;
  } catch {
    return false;
  }
  const send = `<C-\\><C-N>:drop ${line ? `+${line} ` : ""}${abs}<CR>`;
  try {
    const r = Bun.spawnSync(["nvim", "--server", NVIM_SOCKET, "--remote-send", send]);
    if (r.exitCode === 0) return true;
    NVIM_SOCKET = findNvimSocket();
    return false;
  } catch {
    return false;
  }
}
