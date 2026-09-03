// Pushing a nudge into an agent's harness session inbox.
//
// Claude Code binds a per-session Unix socket and documents it as a place for
// "a script or hook to post into a session" (docs: cross-session-messaging).
// The wire is newline-delimited JSON, fire-and-forget — there is NO ack, so a
// write that lands tells us nothing about whether the message was delivered,
// held for approval, or dropped. That asymmetry is why Submit probes liveness
// and reports failure loudly: a connect error is the only signal we ever get.
//
// We deliberately send no `from` reply address. A valid one has to be a socket
// in the harness's own namespace, and r3 could only supply that by binding
// `cc-socks/<pid>.sock` itself — which would squat that namespace and make the
// daemon show up as a session in the harness's own agent list.
//
// Consequence, measured rather than assumed: without a reply address the harness
// cannot send us its "message held" receipt either, so a session whose inbound
// policy holds our push is indistinguishable to us from one that read it.

import { statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname } from "node:path";
import type { ListenerTarget } from "./watchers.ts";

// A human clicked Submit and is waiting on this: long enough that a busy machine
// isn't a false negative, short enough that a wedged socket doesn't hold the
// click. These are local Unix sockets; anything slower than this is genuinely wrong.
const PUSH_TIMEOUT_MS = 5000;
// Admission-time liveness. A local connect either resolves or fails at once.
const PROBE_TIMEOUT_MS = 1000;

// The private per-user directories the harness is documented to use. The parent
// is matched lexically (`dirname`, so `cc-socks/../..` and a nested subdirectory
// both miss); what the path finally resolves TO is the stat check below, which
// follows the link chain and demands a real socket owned by us.
const SOCKET_DIRS = [
  /^\/run\/user\/\d+\/cc-socks$/,
  /^\/tmp\/cc-socks(?:-\d+)?$/,
  /^\/private\/tmp\/cc-socks(?:-\d+)?$/,
  /^\/data\/data\/com\.termux\/files\/usr\/tmp\/cc-socks(?:-\d+)?$/,
];

// `r3 listen` hands us a filesystem path that the daemon will later connect to
// and write to. The API is already localhost- and token-gated, so the caller is
// trusted — but "the daemon connects to an arbitrary path on request" is a
// primitive worth not having. Require the harness's own namespace, a real
// socket, and our own uid.
export function validateSocketPath(p: string): string | null {
  // Shape first, filesystem second: an obviously-wrong path is rejected without
  // touching the disk, and the pure rules stay testable without a real socket.
  if (!p || typeof p !== "string") return "missing socket path";
  if (!p.startsWith("/")) return "socket path must be absolute";
  if (p.includes("\0")) return "socket path contains a null byte";
  if (!p.endsWith(".sock")) return "socket path must name a .sock";
  if (!SOCKET_DIRS.some((re) => re.test(dirname(p))))
    return "socket is outside the harness socket directory";
  let st: ReturnType<typeof statSync>;
  try {
    // statSync follows the symlink chain, so the checks below are about the thing
    // actually opened — a symlink pointing out of the namespace still has to land
    // on a socket owned by us.
    st = statSync(p);
  } catch {
    return "socket does not exist";
  }
  if (!st.isSocket()) return "path is not a socket";
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) return "socket belongs to another user";
  return null;
}

// What the agent actually reads. Two constraints shape it.
//
// The harness drops *identical* repeats arriving close together, so every nudge
// has to be distinct. The review id separates two reviews; the timestamp
// separates two Submits on the SAME review, which is the case that actually
// loses content: the human submits, the agent wakes and runs `r3 prompt`
// (marking round 1 sent), the human submits again seconds later, and a
// byte-identical nudge is dropped — leaving round 2 unsent with nothing to
// report it. That is the silent non-delivery this whole design exists to
// prevent, so it is not worth saving a dozen characters over. The format
// mirrors the harness's own injected notices, which timestamp for the same reason.
//
// And we send no reply address, so the sender renders as unknown and the text
// has to say who it is from.
export function nudgeText(
  reviewId: string,
  title: string,
  event: "submitted" | "approved" | "abandoned",
  now: Date = new Date(),
): string {
  const headline =
    event === "submitted"
      ? "feedback submitted"
      : event === "approved"
        ? "approved — the loop is done"
        : "abandoned — closed without approval";
  const at = now.toISOString().replace(/\.\d+Z$/, "Z");
  const lines = [`[r3] ${reviewId} — ${headline} at ${at}`, `Review: ${title}`];
  // Only the submitted case has anything to fetch; the terminal two are the
  // whole message, and telling an agent to run `prompt` on a closed review
  // would send it after content that is not coming.
  if (event === "submitted") lines.push(`Run: r3 prompt ${reviewId}`);
  return lines.join("\n");
}

function openSocket(path: string, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(path);
    const done = (err: Error | null) => {
      sock.removeAllListeners();
      clearTimeout(timer);
      if (err) {
        sock.destroy();
        reject(err);
        return;
      }
      // `removeAllListeners` took the `error` handler with it, and a socket
      // without one *throws* on the next EPIPE/ECONNRESET — a session that exits
      // between our connect and our write would reach the daemon's process-level
      // uncaught-exception net instead of being handled here. Nothing reads this
      // socket and `write` reports its own failure through its callback, so
      // swallowing is the entire handling it needs.
      sock.on("error", () => {});
      resolve(sock);
    };
    const timer = setTimeout(() => done(new Error("timed out")), timeoutMs);
    sock.once("connect", () => done(null));
    sock.once("error", done);
  });
}

// Is the session behind this inbox still there? A vanished socket file
// (ENOENT) or a socket nobody is accepting on (ECONNREFUSED) both mean gone.
export const probeInbox: (target: ListenerTarget) => Promise<boolean> = async (target) => {
  if (validateSocketPath(target.socket) !== null) return false;
  try {
    (await openSocket(target.socket, PROBE_TIMEOUT_MS)).destroy();
    return true;
  } catch {
    return false;
  }
};

// One nudge. Resolves on a completed write, rejects on anything else — the
// caller turns a rejection into a failed Submit and drops the listener.
export async function pushToInbox(target: ListenerTarget, text: string): Promise<void> {
  const invalid = validateSocketPath(target.socket);
  if (invalid) throw new Error(invalid);
  const sock = await openSocket(target.socket, PUSH_TIMEOUT_MS);
  let written = false;
  try {
    // The auth line is optional on macOS/Linux for the connection to be ACCEPTED,
    // but acceptance is not delivery: the token is what identifies us as the
    // session's own tooling rather than an unattributed peer, whose message is held
    // for manual approval. Registration requires one (see ListenRequest), so it
    // always goes first — there is no unattributed push to fall back to.
    const lines = [
      JSON.stringify({ type: "auth", token: target.token }),
      JSON.stringify({ type: "user", message: { role: "user", content: text } }),
    ];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), PUSH_TIMEOUT_MS);
      sock.write(`${lines.join("\n")}\n`, (err) => {
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      });
    });
    written = true;
  } finally {
    // Only a completed write earns a graceful close. A peer wedged with a full
    // buffer never reads our FIN, so `end()` on the timeout path would hold the
    // fd open for as long as it stays wedged — one leaked fd per Submit.
    if (written) sock.end();
    else sock.destroy();
  }
}
