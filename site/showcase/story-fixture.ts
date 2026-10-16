import { type ArtifactDocumentTarget, artifactReferenceContext } from "../../shared/artifacts.ts";
import {
  type ArtifactDemoSeed,
  type DemoPublication,
  demoStorageUsage,
} from "../../web/demo/artifact-model.ts";
import { artifactFixture, artifactFixtureThread } from "../../web/src/artifact-fixtures.ts";

declare const STORY_PUBLICATIONS: Record<string, DemoPublication>;
export function storySeed(
  palette: Pick<ArtifactDemoSeed, "themes" | "themeStyles">,
  scene: "proposal" | "code-review",
): ArtifactDemoSeed {
  const proposal = scene === "proposal";
  const id = `artifact_example_${scene}`;
  const threadId = `thread_${scene}_feedback`;
  const publications = Object.fromEntries(
    Object.entries(STORY_PUBLICATIONS).filter(([key]) => key.startsWith(`${id}/`)),
  );
  const target = (versionSeq: number): ArtifactDocumentTarget =>
    proposal
      ? {
          kind: "rendered",
          versionSeq,
          path: "proposal.md",
          locator: { selector: "ol", label: "First-session sequence" },
        }
      : {
          kind: "diff",
          versionSeq,
          path: "create-project.ts",
          locator: {
            side: "new",
            quote: versionSeq === 1 ? "await createProject(values);" : "setPending(false);",
            start: versionSeq === 1 ? 4 : 8,
            end: versionSeq === 1 ? 5 : 10,
          },
        };
  const actor = { role: "agent" as const, sessionId: "demo-agent" };
  return {
    ...palette,
    projects: [],
    publications,
    pending: {},
    artifacts: [
      {
        ...structuredClone(artifactFixture),
        id,
        kind: proposal ? "files" : "diff",
        title: proposal
          ? "Fieldwork · First-session proposal"
          : "Fieldwork · Prevent duplicate submissions",
        createdBy: actor,
        nextSeq: 3,
        watching: true,
        agentLabels: { "demo-agent": "Example agent" },
        versions: Object.values(publications).map((item) => item.version),
        storage: demoStorageUsage(Object.values(publications)),
        threads: [
          {
            ...structuredClone(artifactFixtureThread),
            id: threadId,
            artifactId: id,
            target: target(1),
            comments: [
              {
                ...artifactFixtureThread.comments[0]!,
                id: "comment_story_question",
                threadId,
                artifactId: id,
                body: proposal
                  ? "Let me get a first win on my own. Move invitations after the first useful dashboard."
                  : "If the request fails, pending stays true. Can I retry without losing my inputs?",
                context: artifactReferenceContext(target(1)),
              },
              {
                ...artifactFixtureThread.comments[1]!,
                id: "comment_story_fix",
                threadId,
                artifactId: id,
                author: actor,
                body: proposal
                  ? "Moved invitations after project creation, the first milestone, and the dashboard. Solo exploration now comes first."
                  : "The finally block always clears pending. Failure shows a retry message and keeps the existing form values.",
                context: artifactReferenceContext(target(2)),
                target: target(2),
              },
            ],
          },
        ],
      },
    ],
  };
}
