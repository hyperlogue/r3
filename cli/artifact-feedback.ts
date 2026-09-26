import { type ArtifactClient, artifactApiPath } from "../shared/artifact-client.ts";
import type { ArtifactFeedbackRead, ArtifactFeedbackSnapshot } from "../shared/artifacts.ts";

// A failed read or output leaves the batch pending. A failed acknowledgment may
// repeat already printed content, but can never consume a newer batch silently.
export async function fetchArtifactFeedback(
  client: ArtifactClient,
  id: string,
  write: (text: string) => void | Promise<void>,
  options: { all?: boolean; feedback?: string } = {},
): Promise<void> {
  const base = `${artifactApiPath(id)}/feedback`;
  const query = options.feedback ? `?feedback=${encodeURIComponent(options.feedback)}` : "";
  if (options.all) {
    const history = await client.json<ArtifactFeedbackRead>("GET", `${base}/history${query}`);
    await write(history.text);
    return;
  }
  const snapshot = await client.json<ArtifactFeedbackSnapshot>("GET", `${base}/pending${query}`);
  await write(snapshot.text);
  try {
    await client.json("POST", `${base}/acknowledge`, snapshot.acknowledgment);
  } catch (error) {
    if (error instanceof Error)
      error.message = `Feedback was printed, but acknowledgment was not confirmed. Fetch again; some output may repeat. ${error.message}`;
    throw error;
  }
}
