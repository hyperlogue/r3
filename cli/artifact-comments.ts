import { relative } from "node:path";
import { type ArtifactClient, artifactApiPath } from "../shared/artifact-client.ts";
import type { ArtifactCommentRead, ArtifactCommentSnapshot } from "../shared/artifacts.ts";
import { downloadCommentImages } from "./attachment-files.ts";

// A failed read or output leaves the batch pending. A failed acknowledgment may
// repeat already printed content, but can never consume a newer batch silently.
export async function fetchArtifactComments(
  client: ArtifactClient,
  id: string,
  write: (text: string) => void | Promise<void>,
  options: { all?: boolean; threads?: string; attachmentsDir?: string; cwd?: string } = {},
): Promise<void> {
  const base = `${artifactApiPath(id)}/comments`;
  const query = options.threads ? `?threads=${encodeURIComponent(options.threads)}` : "";
  const locations = (saved: string[]) =>
    saved.length
      ? `\nDownloaded images:\n${saved.map((path) => (options.cwd ? relative(options.cwd, path) : path)).join("\n")}\n`
      : "";
  if (options.all) {
    const history = await client.json<ArtifactCommentRead>("GET", `${base}/history${query}`);
    const saved = options.attachmentsDir
      ? await downloadCommentImages(client, history.attachments ?? [], options.attachmentsDir)
      : [];
    await write(history.text + locations(saved));
    return;
  }
  const snapshot = await client.json<ArtifactCommentSnapshot>("GET", `${base}/pending${query}`);
  const saved = options.attachmentsDir
    ? await downloadCommentImages(client, snapshot.attachments ?? [], options.attachmentsDir)
    : [];
  await write(snapshot.text + locations(saved));
  try {
    await client.json("POST", `${base}/acknowledge`, snapshot.acknowledgment);
  } catch (error) {
    if (error instanceof Error)
      error.message = `Comments were printed, but acknowledgment was not confirmed. Fetch again; some output may repeat. ${error.message}`;
    throw error;
  }
}
