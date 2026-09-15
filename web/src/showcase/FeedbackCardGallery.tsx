import { useQuery } from "@tanstack/react-query";
import type { ArtifactFeedback, ArtifactReply, ArtifactTarget } from "../../../shared/artifacts.ts";
import { demo, human } from "../../demo/artifact-backend.ts";
import { artifactApi } from "../artifact-api.ts";
import { useOptimisticArtifact } from "../artifact-feedback-status.ts";
import { ArtifactThreadCard } from "../components/ArtifactThreads.tsx";

const filesId = "artifact_gallery_files";
const diffId = "artifact_gallery_diff";
const examples = [
  ["new", "New feedback · not sent", filesId],
  ["sent", "Sent feedback · waiting for the agent", filesId],
  ["working", "Agent working", filesId],
  ["attention", "Agent replied · needs your attention", filesId],
  ["followup", "Human follow-up · waiting for the agent", filesId],
  ["resolved", "Resolved · with a fix in a later version", filesId],
  ["rendered", "Rendered anchor · long quotation", filesId],
  ["diff", "Diff anchor · code in the message", diffId],
  ["history", "Long conversation · earlier replies", filesId],
  ["agent", "Agent-created feedback", filesId],
] as const;
const feedbackId = (key: string) => `feedback_gallery_${key}`;

// Synthetic conversations use separate demo artifacts so trying their actions
// does not change the main panel sample or its file/diff examples.
export function seedFeedbackCardGallery() {
  for (const [sourceId, id] of [
    ["artifact_documents", filesId],
    ["artifact_code", diffId],
  ] as const) {
    const source = demo.get(sourceId);
    const detail = structuredClone(source);
    const publications = source.versions.map((version) => demo.publication(sourceId, version.seq));
    const pending = demo.state.pending[sourceId];
    if (pending) publications.push(pending);
    detail.id = id;
    detail.title = "Feedback card examples";
    detail.feedback = [];
    detail.placements = [];
    detail.events = [];
    detail.versions = publications.map((publication) => {
      const copy = structuredClone(publication);
      copy.version.artifactId = id;
      demo.state.publications[`${id}/${copy.version.seq}`] = copy;
      return copy.version;
    });
    detail.nextSeq = detail.versions.at(-1)!.seq + 1;
    demo.state.artifacts = demo.state.artifacts.filter((item) => item.id !== id);
    demo.state.artifacts.push(detail);
  }
  const time = new Date().toISOString();
  const agent = { role: "agent" as const, sessionId: "sample-agent" };
  const sourceTarget = structuredClone(demo.get("artifact_documents").feedback[0]!.target);
  const diffTarget = structuredClone(demo.get("artifact_code").feedback[0]!.target);
  if (sourceTarget.kind !== "source") throw new Error("The gallery needs a source anchor sample");
  const add = (key: string, body: string, target: ArtifactTarget = { kind: "artifact" }) => {
    const artifactId = key === "diff" ? diffId : filesId;
    const note: ArtifactFeedback = {
      id: feedbackId(key),
      artifactId,
      author: human,
      body,
      status: "open",
      target,
      legacy: null,
      createdAt: time,
      updatedAt: time,
      sentAt: time,
      statusUnsent: false,
      replies: [],
      claim: null,
    };
    demo.get(artifactId).feedback.push(note);
    return note;
  };
  const reply = (
    note: ArtifactFeedback,
    body: string,
    role: "agent" | "human" = "agent",
    seq = 1,
  ) => {
    const message: ArtifactReply = {
      id: `${note.id}_reply_${note.replies.length + 1}`,
      feedbackId: note.id,
      artifactId: note.artifactId,
      author: role === "human" ? human : agent,
      body,
      context: { versionSeq: seq, representation: "source" },
      target: null,
      legacy: null,
      createdAt: time,
      sentAt: time,
    };
    note.replies.push(message);
    return message;
  };

  add("new", "Could we make the selected version easier to spot?").sentAt = null;
  add(
    "sent",
    "Keep the version I am reading selected when a new publication arrives. **My draft should stay where I started it**, too.",
    sourceTarget,
  );
  const working = add("working", "Please keep the version selector visible when I scroll.");
  working.claim = {
    feedbackId: working.id,
    sessionId: agent.sessionId,
    claimedAt: time,
    renewedAt: time,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };
  const attention = add("attention", "What happens to comments when we publish an update?", {
    kind: "source",
    versionSeq: 2,
    path: "index.md",
    locator: null,
  });
  reply(
    attention,
    "The original comment stays attached to the version you reviewed.\n\n- You can return to that exact target.\n- A later fix can point to a different version.\n- Publishing an update leaves the thread open for you to resolve.\n\nDoes this match what you expected?",
    "agent",
    2,
  );
  const followup = add("followup", "The selected version needs to be clearer.");
  reply(followup, "I can add a short version badge beside the title.");
  reply(followup, "Yes, and keep its label visible when there is enough room.", "human").sentAt =
    null;
  const resolved = add("resolved", "Keep my selected publication pinned.", sourceTarget);
  reply(
    resolved,
    "The selected version now stays pinned. You can try it in version 2.",
    "agent",
    2,
  ).target = { ...sourceTarget, versionSeq: 2 };
  resolved.status = "resolved";
  add(
    "rendered",
    "This explanation repeats a few ideas. Could we shorten it while keeping the distinction between the original comment and the later fix?",
    {
      kind: "rendered",
      versionSeq: 1,
      path: "index.md",
      locator: {
        selector: "main > section",
        quote:
          "Each publication is a complete version of the artifact.\nYou can switch between versions without losing your place in the conversation.\nComments keep the version and target you originally selected.\nA reply can point to a fix in a later publication.\nPublishing that fix leaves the final decision to you.",
        route: "#versions",
      },
    },
  );
  add(
    "diff",
    "Could this preserve an explicit selection?\n\n```ts\nreturn selected ?? latest;\n```\n\nAn update should not move the reader away from the version they chose.",
    diffTarget,
  );
  const history = add("history", "Can we keep a long conversation easy to scan?");
  for (const [index, body] of [
    "I can collapse older replies while keeping the latest exchange visible.",
    "How many replies would remain visible?",
    "The latest three, with an action to show the rest.",
    "Keep the earlier replies in their original order.",
    "Yes. Expanding them reveals the complete conversation in order.",
    "And I should still be able to select text from those replies.",
    "You can expand the earlier replies and select a passage to quote in your response. Please try it here.",
  ].entries()) {
    reply(history, body, index % 2 ? "human" : "agent");
  }
  add("agent", "One open question: should a long file path wrap, or stay on a single line?", {
    kind: "source",
    versionSeq: 1,
    path: "index.md",
    locator: null,
  }).author = agent;
  demo.changed(filesId);
  demo.changed(diffId);
}

function CardExample({
  example: [key, label, artifactId],
  announce,
}: {
  example: (typeof examples)[number];
  announce: (message: string) => void;
}) {
  const { data = demo.get(artifactId) } = useQuery({
    queryKey: ["artifact", artifactId],
    queryFn: () => artifactApi.detail(artifactId),
  });
  const detail = useOptimisticArtifact(data);
  const note = detail.feedback.find((item) => item.id === feedbackId(key));
  return (
    <section data-card-example={key} className="min-w-0 space-y-2">
      <h3 className="text-sm font-medium">{label}</h3>
      <div className="border border-neutral-300 dark:border-neutral-700 [&>article]:border-b-0">
        {note ? (
          <ArtifactThreadCard
            feedback={note}
            latestVersionSeq={detail.versions.at(-1)?.seq ?? null}
            context={{ versionSeq: 2, representation: key === "diff" ? "diff" : "source" }}
            onLocate={() =>
              announce("Sample anchor selected. Use outer comment mode to review this card.")
            }
            onJumpRef={() => announce("Sample file reference selected")}
          />
        ) : (
          <p className="p-3 text-sm text-neutral-500">Sample deleted. Reload to restore it.</p>
        )}
      </div>
    </section>
  );
}

export function FeedbackCardGallery({ announce }: { announce: (message: string) => void }) {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-2">
      {examples.map((example) => (
        <CardExample key={example[0]} example={example} announce={announce} />
      ))}
    </div>
  );
}
