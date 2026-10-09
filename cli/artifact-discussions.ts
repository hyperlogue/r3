import { relative } from "node:path";
import { type ArtifactClient, artifactApiPath } from "../shared/artifact-client.ts";
import type { ArtifactDiscussionRead, ArtifactDiscussionSnapshot } from "../shared/artifacts.ts";
import { downloadDiscussionImages } from "./attachment-files.ts";

// A failed read or output leaves the batch pending. A failed acknowledgment may
// repeat already printed content, but can never consume a newer batch silently.
export async function fetchArtifactDiscussion(
  client: ArtifactClient,
  id: string,
  write: (text: string) => void | Promise<void>,
  options: { all?: boolean; discussions?: string; attachmentsDir?: string; cwd?: string } = {},
): Promise<void> {
  const base = `${artifactApiPath(id)}/discussions`;
  const query = options.discussions
    ? `?discussions=${encodeURIComponent(options.discussions)}`
    : "";
  const locations = (saved: string[]) =>
    saved.length
      ? `\nDownloaded images:\n${saved.map((path) => (options.cwd ? relative(options.cwd, path) : path)).join("\n")}\n`
      : "";
  if (options.all) {
    const history = await client.json<ArtifactDiscussionRead>("GET", `${base}/history${query}`);
    const saved = options.attachmentsDir
      ? await downloadDiscussionImages(client, history.attachments ?? [], options.attachmentsDir)
      : [];
    await write(history.text + locations(saved));
    return;
  }
  const snapshot = await client.json<ArtifactDiscussionSnapshot>("GET", `${base}/pending${query}`);
  const saved = options.attachmentsDir
    ? await downloadDiscussionImages(client, snapshot.attachments ?? [], options.attachmentsDir)
    : [];
  await write(snapshot.text + locations(saved));
  try {
    await client.json("POST", `${base}/acknowledge`, snapshot.acknowledgment);
  } catch (error) {
    if (error instanceof Error)
      error.message = `Discussion was printed, but acknowledgment was not confirmed. Fetch again; some output may repeat. ${error.message}`;
    throw error;
  }
}
