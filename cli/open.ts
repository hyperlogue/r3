import { readDaemonJson } from "../server/config.ts";
import { ArtifactCommandError } from "./artifact-args.ts";
import { selectedBackend } from "./backend.ts";
import { discoverArtifactServer } from "./daemon-client.ts";
import { localBootstrap } from "./local-bootstrap.ts";

export async function openCommand(args: string[]): Promise<void> {
  if (args.length > 1 || (args[0] && !/^(?:artifact|review)_[a-zA-Z0-9_]+$/.test(args[0])))
    throw new ArtifactCommandError("open [artifact-id]");
  const path = args[0] ? `/${args[0]}` : "/";
  const remote = selectedBackend();
  if (remote) {
    console.log(`${remote}${path}`);
    return;
  }
  await discoverArtifactServer();
  const socket = readDaemonJson()?.bootstrapSocket;
  if (!socket) throw new ArtifactCommandError("Restart the local server to enable browser setup");
  const result = await localBootstrap<{ url: string }>(socket, "browser", { path });
  console.log(result.url);
}
