import { ArtifactCommandError } from "./artifact-args.ts";
import { selectedBackend } from "./backend.ts";
import { localBrowserUrl } from "./daemon-client.ts";

export async function openCommand(args: string[]): Promise<void> {
  if (args.length > 1 || (args[0] && !/^(?:artifact|review)_[a-zA-Z0-9_]+$/.test(args[0])))
    throw new ArtifactCommandError("open [artifact-id]");
  const path = args[0] ? `/${args[0]}` : "/";
  const remote = selectedBackend();
  if (remote) {
    console.log(`${remote}${path}`);
    return;
  }
  console.log(await localBrowserUrl(path));
}
