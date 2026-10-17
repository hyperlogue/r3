import { compareVersions, R3_VERSION } from "../shared/version.ts";

export interface ServerHealth {
  ok: boolean;
  version?: string;
  protocol?: string;
}

export function serverCompatibility(health: ServerHealth, url: string, local: boolean) {
  const compatible = health.protocol === "artifacts-v3";
  if (compatible && health.version === R3_VERSION) return { compatible, message: null };
  const versions = `Server at ${url}: v${health.version ?? "unknown"} (${health.protocol ?? "unknown protocol"}); CLI: v${R3_VERSION} (artifacts-v3).`;
  const order = health.version ? compareVersions(R3_VERSION, health.version) : null;
  let recovery: string;
  if (order !== null && order > 0) {
    recovery = local
      ? "The CLI is newer than the server. Ask the user to confirm running r3 server restart with this newer CLI on this machine."
      : "The CLI is newer than the server. Ask the user to confirm upgrading r3 and running r3 server restart on the server's machine.";
  } else if (order !== null && order < 0) {
    recovery =
      "The server is newer than this CLI. Upgrade or switch the CLI to match the server. Do not restart the server with this older CLI.";
  } else {
    recovery = `Release versions do not identify which build needs updating. Align the CLI and server builds; ask the user to confirm before running r3 server restart${local ? " on this machine" : " on the server's machine"}.`;
  }
  return {
    compatible,
    message: compatible
      ? `Version mismatch. ${versions} The protocol is compatible; continuing. ${recovery}`
      : `Incompatible backend protocol. ${versions} ${recovery}`,
  };
}
