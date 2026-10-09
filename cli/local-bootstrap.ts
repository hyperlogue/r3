import { lstatSync } from "node:fs";
import { dirname } from "node:path";

export async function localBootstrap<T>(
  socket: string,
  operation: "bootstrap" | "browser",
  body = {},
): Promise<T> {
  for (const [path, directory] of [
    [dirname(socket), true],
    [socket, false],
  ] as const) {
    const stat = lstatSync(path);
    if (
      (directory ? !stat.isDirectory() : !stat.isSocket()) ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Local bootstrap requires an owner-only socket and directory");
  }
  const response = await fetch(`http://localhost/api/local/${operation}`, {
    unix: socket,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Local server setup failed");
  return response.json() as Promise<T>;
}
