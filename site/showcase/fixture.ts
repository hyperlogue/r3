import type { ArtifactDetail, ArtifactVersion } from "../../shared/artifacts.ts";
import type { ArtifactDemoSeed, DemoPublication } from "../../web/demo/artifact-model.ts";
import { artifactFixture, artifactFixtureThread } from "../../web/src/artifact-fixtures.ts";

export const COMPONENT_THREAD = "thread_components_margin";
export const COMPONENTS_ID = "artifact_example_components";
export const FIELDWORK_ID = "artifact_example_fieldwork";
export const VISIBILITY_THREAD = "thread_fieldwork_visibility";
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
    threads: [
      {
        ...structuredClone(artifactFixtureThread),
        id: VISIBILITY_THREAD,
        artifactId: FIELDWORK_ID,
        target: target(1),
        comments: [
          {
            ...artifactFixtureThread.comments[0]!,
            id: "comment_fieldwork_question",
            threadId: VISIBILITY_THREAD,
            artifactId: FIELDWORK_ID,
            body: "Who can see a workspace project? Explain this before I create it.",
            context: { versionSeq: 1, representation: "rendered" },
          },
          {
            ...artifactFixtureThread.comments[1]!,
            id: "comment_fieldwork_fix",
            threadId: VISIBILITY_THREAD,
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
  return {
    artifacts: [detail],
    projects: [],
    publications: htmlPublications(versions),
    pending: {},
    themes: palette.themes,
    themeStyles: palette.themeStyles,
  };
}

function htmlPublications(versions: ArtifactVersion[]) {
  return Object.fromEntries(
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
        // React supplies the document; the demo still needs source membership
        // to validate native rendered targets when a new comment is saved.
        sources: {
          "index.html": {
            ...file,
            artifactId: version.artifactId,
            versionSeq: version.seq,
            kind: "text",
            language: "html",
            lines: [],
          },
        },
        resources: {},
        diff: [],
        fullDiff: [],
        storageBlobs: { [version.contentHash]: file.byteLength },
        patchBytes: 0,
      };
      return [`${version.artifactId}/${version.seq}`, publication];
    }),
  );
}

export function componentsSeed(
  palette: Pick<ArtifactDemoSeed, "themes" | "themeStyles">,
): ArtifactDemoSeed {
  const versions: ArtifactVersion[] = [1, 2].map((seq) => ({
    artifactId: COMPONENTS_ID,
    seq,
    publicationKey: `components-${seq}`,
    contentHash: `components-content-${seq}`,
    label: seq === 1 ? "Card component" : "Increase button margin",
    summary:
      seq === 1
        ? "A card with an 8px button margin."
        : "Increased the button’s top margin to 16px.",
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
    locator: { selector: "#component-action", label: "Button spacing" },
  });
  return {
    artifacts: [
      {
        ...structuredClone(artifactFixture),
        id: COMPONENTS_ID,
        title: "UI component showcase",
        kind: "html",
        createdBy: actor,
        nextSeq: 3,
        storage: { totalBytes: 2048, latestVersionBytes: 1024 },
        watching: true,
        agentLabels: { "demo-agent": "Example agent" },
        versions,
        placements: [
          {
            threadId: COMPONENT_THREAD,
            artifactId: COMPONENTS_ID,
            target: target(2),
            state: "anchored",
            createdAt: time,
            updatedAt: time,
          },
        ],
        threads: [
          {
            ...structuredClone(artifactFixtureThread),
            id: COMPONENT_THREAD,
            artifactId: COMPONENTS_ID,
            target: target(1),
            comments: [
              {
                ...artifactFixtureThread.comments[0]!,
                id: "comment_components_request",
                threadId: COMPONENT_THREAD,
                artifactId: COMPONENTS_ID,
                body: "Increase the margin above this button to 16px.",
                context: { versionSeq: 1, representation: "rendered" },
              },
              {
                ...artifactFixtureThread.comments[1]!,
                id: "comment_components_fix",
                threadId: COMPONENT_THREAD,
                artifactId: COMPONENTS_ID,
                author: actor,
                body: "Increased the top margin from 8px to 16px.",
                context: { versionSeq: 2, representation: "rendered" },
                target: target(2),
              },
            ],
          },
        ],
      },
    ],
    projects: [],
    publications: htmlPublications(versions),
    pending: {},
    themes: palette.themes,
    themeStyles: palette.themeStyles,
  };
}
