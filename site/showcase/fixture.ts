import type { ArtifactDetail, ArtifactVersion } from "../../shared/artifacts.ts";
import type { ArtifactDemoSeed, DemoPublication } from "../../web/demo/artifact-model.ts";
import { artifactFixture, artifactFixtureDiscussion } from "../../web/src/artifact-fixtures.ts";

export const FIELDWORK_ID = "artifact_example_fieldwork";
export const VISIBILITY_DISCUSSION = "discussion_fieldwork_visibility";
const actor = { role: "agent" as const, sessionId: "demo-agent" };
const time = "2026-09-11T12:00:00.000Z";

// Fictional publications and conversations, rendered by the real ArtifactPage.
// Nothing in this fixture is loaded from a user's workspace.
export function fieldworkSeed(
  palette: Pick<ArtifactDemoSeed, "themes" | "themeStyles">,
): ArtifactDemoSeed {
  const versions: ArtifactVersion[] = [1, 2].map((seq) => ({
    artifactId: FIELDWORK_ID,
    seq,
    publicationKey: `fieldwork-${seq}`,
    contentHash: `fieldwork-content-${seq}`,
    label: seq === 1 ? "Project creation" : "Explain project visibility",
    summary:
      seq === 1
        ? "A project creation form for Example Fieldwork. Review the visibility setting."
        : "Added an explanation of who can access a workspace project, before creation.",
    publishedBy: actor,
    provenance: {},
    createdAt: time,
    publishedAt: time,
    kind: "html",
    entrypoint: "index.html",
    fileCount: 1,
  }));
  const target = (versionSeq: number) => ({
    kind: "rendered" as const,
    versionSeq,
    path: "index.html",
    locator: { selector: "#visibility", label: "Project visibility" },
  });
  const detail: ArtifactDetail = {
    ...structuredClone(artifactFixture),
    id: FIELDWORK_ID,
    title: "Example Fieldwork · Project creation",
    kind: "html",
    createdBy: actor,
    nextSeq: 3,
    storage: { totalBytes: 2048, latestVersionBytes: 1024 },
    watching: true,
    agentLabels: { "demo-agent": "Example agent" },
    versions,
    discussions: [
      {
        ...structuredClone(artifactFixtureDiscussion),
        id: VISIBILITY_DISCUSSION,
        artifactId: FIELDWORK_ID,
        target: target(1),
        comments: [
          {
            ...artifactFixtureDiscussion.comments[0]!,
            id: "comment_fieldwork_question",
            discussionId: VISIBILITY_DISCUSSION,
            artifactId: FIELDWORK_ID,
            body: "Who can see a workspace project? Explain this before I create it.",
            context: { versionSeq: 1, representation: "rendered" },
          },
          {
            ...artifactFixtureDiscussion.comments[1]!,
            id: "comment_fieldwork_fix",
            discussionId: VISIBILITY_DISCUSSION,
            artifactId: FIELDWORK_ID,
            author: actor,
            body: "Added an explanation beneath the visibility setting. Your choice stays editable.",
            context: { versionSeq: 2, representation: "rendered" },
            target: target(2),
          },
        ],
      },
    ],
  };
  const publications = Object.fromEntries(
    versions.map((version) => {
      const file = {
        path: "index.html",
        hash: version.contentHash,
        byteLength: 1024,
        mediaType: "text/html",
        renderedHash: null,
        rendererRevision: null,
      };
      const publication: DemoPublication = {
        version,
        files: [file],
        sources: {},
        resources: {},
        diff: [],
        fullDiff: [],
        storageBlobs: { [version.contentHash]: file.byteLength },
        patchBytes: 0,
      };
      return [`${FIELDWORK_ID}/${version.seq}`, publication];
    }),
  );
  return {
    artifacts: [detail],
    projects: [],
    publications,
    pending: {},
    themes: palette.themes,
    themeStyles: palette.themeStyles,
  };
}
