import type { ArtifactDetail, ArtifactVersion } from "../../shared/artifacts.ts";
import type { ArtifactDemoSeed, DemoPublication } from "../../web/demo/artifact-model.ts";
import { artifactFixture, artifactFixtureThread } from "../../web/src/artifact-fixtures.ts";
import type { PromptScene } from "../prompt-examples.ts";

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
  scene: PromptScene = "prototype",
): ArtifactDemoSeed {
  const scenario = {
    prototype: {
      title: "Example Fieldwork · Project creation",
      selector: "#visibility",
      target: "Project visibility",
      labels: ["Project creation", "Explain project visibility"],
      summaries: [
        "A project creation form for Example Fieldwork. Review the visibility setting.",
        "Added an explanation of who can access a workspace project, before creation.",
      ],
      question: "Who can see a workspace project? Explain this before I create it.",
      reply: "Added an explanation beneath the visibility setting. Your choice stays editable.",
    },
    explainer: {
      title: "Search lab · Ranking signals",
      selector: "#ranking-signals",
      target: "Ranking signals",
      labels: ["Search ranking lab", "Explain the ranking signals"],
      summaries: [
        "An interactive explanation of search ranking.",
        "Added a plain-language explanation beside the adjustable relevance and freshness weights.",
      ],
      question: "What does freshness change? Let me compare it with relevance.",
      reply:
        "Added both sliders and explained the weighted score. Try moving freshness to see the results reorder.",
    },
    brief: {
      title: "RFC 014 · Project visibility",
      selector: "#access-rules",
      target: "Access rules",
      labels: ["Visibility proposal", "Clarify visibility changes"],
      summaries: [
        "A design proposal for workspace and private projects, with alternatives and rollout.",
        "Specified how visibility changes affect existing members and shared links.",
      ],
      question: "What happens to existing members and shared links when a project becomes private?",
      reply:
        "Clarified that invited members keep access. Everyone else loses access immediately, including through existing links.",
    },
  }[scene];
  const id = scene === "prototype" ? FIELDWORK_ID : `artifact_example_${scene}`;
  const thread = scene === "prototype" ? VISIBILITY_THREAD : `thread_${scene}_feedback`;
  const versions: ArtifactVersion[] = [1, 2].map((seq) => ({
    artifactId: id,
    seq,
    publicationKey: `${scene}-${seq}`,
    contentHash: `${scene}-content-${seq}`,
    label: scenario.labels[seq - 1]!,
    summary: scenario.summaries[seq - 1]!,
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
    locator: { selector: scenario.selector, label: scenario.target },
  });
  const detail: ArtifactDetail = {
    ...structuredClone(artifactFixture),
    id,
    title: scenario.title,
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
        id: thread,
        artifactId: id,
        target: target(1),
        comments: [
          {
            ...artifactFixtureThread.comments[0]!,
            id: "comment_fieldwork_question",
            threadId: thread,
            artifactId: id,
            body: scenario.question,
            context: { versionSeq: 1, representation: "rendered" },
          },
          {
            ...artifactFixtureThread.comments[1]!,
            id: "comment_fieldwork_fix",
            threadId: thread,
            artifactId: id,
            author: actor,
            body: scenario.reply,
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
