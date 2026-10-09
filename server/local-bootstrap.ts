import { chmodSync, existsSync, lstatSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { privateDirectory } from "../cli/private-state.ts";
import { artifactJson } from "./artifact-http.ts";
import type { LocalBrowserAccess } from "./local-access.ts";

export function startLocalBootstrap(options: {
  socket: string;
  url: string;
  publicUrl: string;
  token: string;
  browser: LocalBrowserAccess;
}) {
  privateDirectory(dirname(options.socket));
  if (existsSync(options.socket)) {
    const stat = lstatSync(options.socket);
    if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid()))
      throw new Error("Refusing to replace an unowned bootstrap socket");
    // The daemon's exclusive start lock protects this owned socket's lifetime.
    rmSync(options.socket);
  }
  const server = Bun.serve({
    unix: options.socket,
    development: false,
    maxRequestBodySize: 4096,
    async fetch(request) {
      const headers = {
        "cache-control": "no-store",
        pragma: "no-cache",
        "content-type": "application/json",
      };
      const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
      if (
        request.headers.has("origin") ||
        request.headers.has("sec-fetch-site") ||
        request.headers.get("host") !== "localhost"
      )
        return json({ error: "Private local clients only" }, 403);
      if (request.method !== "POST") return json({ error: "Not found" }, 404);
      const path = new URL(request.url).pathname;
      if (path === "/api/local/bootstrap")
        return json({ url: options.url, publicUrl: options.publicUrl, token: options.token });
      if (path !== "/api/local/browser") return json({ error: "Not found" }, 404);
      try {
        const body = await artifactJson(request, 4096);
        const destination = body.path ?? "/";
        if (
          typeof destination !== "string" ||
          !/^\/(?:(?:artifact|review)_[a-zA-Z0-9_]+)?$/.test(destination)
        )
          return json({ error: "Invalid browser destination" }, 400);
        return json({
          url: `${options.publicUrl}${destination}#r3-login=${options.browser.issue()}`,
        });
      } catch {
        return json({ error: "Invalid local request" }, 400);
      }
    },
  });
  chmodSync(options.socket, 0o600);
  return {
    async stop() {
      await server.stop(true);
      rmSync(options.socket, { force: true });
    },
  };
}
