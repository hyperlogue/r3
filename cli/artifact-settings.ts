import { isIP } from "node:net";
import {
  type PersistedConfig,
  parseBoolFlag,
  readConfig,
  readConfigForWrite,
  writeConfig,
} from "../server/config.ts";
import type { ArtifactClient } from "../shared/artifact-client.ts";
import { normalizeGitRemote } from "../shared/git-remote.ts";
import type { AuthTokenInfo, CreateAuthTokenResponse } from "../shared/types.ts";
import { ArtifactArgs, ArtifactCommandError } from "./artifact-args.ts";

const NAMES = [
  "bind",
  "port",
  "publicUrl",
  "allowedHosts",
  "requireLogin",
  "previewPort",
  "previewBaseUrl",
  "projectGrouping",
  "projectMappings",
] as const;
export function configCommand(argv: string[]): void {
  const [command = "show", key, raw] = argv;
  if (command === "show" && argv.length <= 1) {
    console.log(JSON.stringify(readConfig(), null, 2));
    return;
  }
  if (!NAMES.includes(key as (typeof NAMES)[number]))
    throw new ArtifactCommandError(`Config name must be one of: ${NAMES.join(", ")}`);
  const name = key as (typeof NAMES)[number];
  if (command === "get" && argv.length === 2) {
    const value = readConfig()[name];
    if (value !== undefined)
      console.log(
        Array.isArray(value)
          ? value.join(",")
          : typeof value === "object"
            ? JSON.stringify(value)
            : String(value),
      );
    return;
  }
  if (command !== "set" && command !== "unset")
    throw new ArtifactCommandError("config show|get|set|unset");
  if (argv.length !== (command === "set" ? 3 : 2))
    throw new ArtifactCommandError("config set <name> <value> | config unset <name>");
  let next: PersistedConfig;
  try {
    next = { ...readConfigForWrite() };
  } catch {
    throw new ArtifactCommandError(
      "The persisted config is invalid JSON; repair it before changing settings",
    );
  }
  if (command === "unset") delete next[name];
  else {
    const value = raw?.trim();
    if (!value) throw new ArtifactCommandError(`Use r3 config unset ${name} to clear this setting`);
    switch (name) {
      case "projectGrouping":
        if (value !== "remote" && value !== "manual")
          throw new ArtifactCommandError("projectGrouping expects remote or manual");
        next.projectGrouping = value;
        break;
      case "projectMappings": {
        let mappings: unknown;
        try {
          mappings = JSON.parse(value);
        } catch {
          throw new ArtifactCommandError(
            "projectMappings expects a JSON object of remote URLs to project IDs",
          );
        }
        if (!mappings || typeof mappings !== "object" || Array.isArray(mappings))
          throw new ArtifactCommandError("projectMappings expects a JSON object");
        const entries: [string, string][] = [];
        const ids = new Map<string, string>();
        for (const [url, id] of Object.entries(mappings)) {
          const remote = normalizeGitRemote(url);
          if (!remote || typeof id !== "string" || !id || id.length > 200)
            throw new ArtifactCommandError("Invalid project remote mapping");
          if (ids.has(remote.key) && ids.get(remote.key) !== id)
            throw new ArtifactCommandError("Conflicting project remote mappings");
          ids.set(remote.key, id);
          entries.push([remote.url, id]);
        }
        next.projectMappings = Object.fromEntries(entries);
        break;
      }
      case "port":
      case "previewPort": {
        const port = Number(value);
        if (!Number.isInteger(port) || port < 1 || port > 65535)
          throw new ArtifactCommandError(`${name} must be between 1 and 65535`);
        next[name] = port;
        break;
      }
      case "bind":
        if (["0.0.0.0", "::", "[::]"].includes(value))
          throw new ArtifactCommandError("Use loopback or an explicitly selected interface");
        next.bind = value;
        break;
      case "publicUrl":
      case "previewBaseUrl": {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          throw new ArtifactCommandError(`${name} requires an HTTP(S) origin`);
        }
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.pathname !== "/" ||
          url.search ||
          url.hash
        )
          throw new ArtifactCommandError(
            `${name} requires an HTTP(S) origin without credentials or a path`,
          );
        if (
          name === "previewBaseUrl" &&
          url.protocol === "http:" &&
          url.hostname !== "localhost" &&
          !url.hostname.endsWith(".localhost") &&
          url.hostname !== "[::1]" &&
          !(isIP(url.hostname) === 4 && url.hostname.startsWith("127."))
        )
          throw new ArtifactCommandError(
            "previewBaseUrl requires an HTTPS origin or an HTTP loopback origin",
          );
        next[name] = url.origin;
        break;
      }
      case "allowedHosts": {
        const hosts = value
          .split(",")
          .map((host) => host.trim())
          .filter(Boolean);
        if (hosts.some((host) => /[\s/*?#@]/.test(host)))
          throw new ArtifactCommandError(
            "allowedHosts requires exact hostnames, without wildcards",
          );
        next.allowedHosts = hosts;
        break;
      }
      case "requireLogin": {
        const enabled = parseBoolFlag(value);
        if (enabled === null)
          throw new ArtifactCommandError("requireLogin expects 1/0 or true/false");
        next.requireLogin = enabled;
        break;
      }
    }
  }
  if (next.port !== undefined && next.port === next.previewPort)
    throw new ArtifactCommandError("Application and preview ports must differ");
  writeConfig(next);
  console.log("Saved r3 configuration. Run r3 restart to apply it.");
}

export async function authCommand(client: ArtifactClient, argv: string[]): Promise<void> {
  const args = new ArtifactArgs(argv);
  args.allow(["label", "all"]);
  const command = args.positional[0];
  if (command === "create-token" && args.positional.length === 1) {
    const result = await client.json<CreateAuthTokenResponse>("POST", "/api/auth/tokens", {
      label: args.value("label") ?? null,
    });
    console.log(result.token);
    console.error(
      `r3: login token created (${result.info.id}); retain this value, it is shown only once`,
    );
    return;
  }
  if (command === "list-tokens" && args.positional.length === 1) {
    const tokens = await client.json<AuthTokenInfo[]>("GET", "/api/auth/tokens");
    if (args.has("json")) console.log(JSON.stringify(tokens, null, 2));
    else
      for (const token of tokens)
        console.log(
          `${token.id} · ${token.label ?? "Unlabeled"} · ${token.lastUsedAt ? `last used ${token.lastUsedAt}` : "unused"}`,
        );
    return;
  }
  if (command === "revoke-token" && args.positional.length === (args.has("all") ? 1 : 2)) {
    const path = args.has("all")
      ? "/api/auth/tokens"
      : `/api/auth/tokens/${encodeURIComponent(args.id(1))}`;
    console.log(JSON.stringify(await client.json("DELETE", path)));
    return;
  }
  throw new ArtifactCommandError(
    "auth create-token [--label L] | list-tokens [--json] | revoke-token <id> | revoke-token --all",
  );
}
