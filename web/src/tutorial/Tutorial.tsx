import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { demo } from "../../demo/artifact-backend.ts";
import { artifactApi } from "../artifact-api.ts";
import { artifactDrafts } from "../artifact-drafts.ts";
import { useArtifactEvents } from "../artifact-hooks.ts";
import { type ArtifactLocation, artifactLocationSearch } from "../artifact-navigation.ts";
import { AppHeader } from "../components/AppHeader.tsx";
import { MessageProse } from "../components/Message.tsx";
import { useTheme } from "../hooks.ts";
import { ArtifactHome } from "../pages/ArtifactHome.tsx";
import { type ArtifactRenderer, ArtifactWorkspace } from "../pages/ArtifactView.tsx";
import { navigate, useRoute } from "../router.ts";
import { setFeedbackMode } from "../settings.ts";
import { Button } from "../ui.tsx";
import { TutorialDocument } from "./Document.tsx";

const primary = "artifact_weekend";
const samples = [primary, "artifact_documents", "artifact_code"];
const lessons = [
  [
    "Publish an artifact",
    "An agent publishes a complete directory. Click Publish sample to begin with version 1.",
  ],
  [
    "Anchor your feedback",
    "In the workspace navbar, enable comment mode. Click “5 min read”, choose Comment here, then write and save your feedback.",
  ],
  [
    "Bring in an agent",
    "Use Send to agent at the top of the feedback panel. The practice agent will claim your note, publish version 2, and reply.",
  ],
  [
    "Review the new version",
    "You are still reading version 1. Use Go to the latest version in the navbar, then compare versions with the version selector.",
  ],
  [
    "Resolve the thread",
    "Click Resolve on your feedback card. Use the Resolved filter to find it again. The agent’s reply leaves this decision to you.",
  ],
  [
    "Explore all three kinds",
    "Use r3 in the workspace navbar to open the artifact list. Visit the HTML, Files, and Diff examples. In Files, try folding Markdown or switching to source.",
  ],
];
const commands = `### Try the real loop

Run these commands in your terminal. The practice workspace above uses a scripted agent.

\`\`\`sh
r3 create --kind html --dir ./artifact --title "Weekend guide"
r3 listen <artifact_id>
# Generic agents can use r3 watch <artifact_id> instead.
r3 prompt <artifact_id>
r3 claim <feedback_id>
# Edit locally, then publish the complete directory.
r3 publish <artifact_id> --dir ./artifact
r3 reply <feedback_id> --version 2 --view rendered -m "Updated the reading estimate."
\`\`\`

Inspect the original target in its explicit version and representation. Each agent uses a distinct logical session. A successful reply releases its claim; the human controls resolution. Use \`r3 guide\` for the complete contract.`;

export function resetPractice() {
  demo.reset();
  for (const detail of demo.state.artifacts) {
    detail.feedback = [];
    detail.watching = true;
    detail.unhandledCount = 0;
    artifactDrafts.clear(detail.id);
    demo.changed(detail.id);
  }
  setFeedbackMode("expanded");
  navigate("/");
}

export function TutorialGuide({
  step,
  done,
  onStep,
}: {
  step: number;
  done: boolean[];
  onStep: (step: number) => void;
}) {
  return (
    <nav
      aria-label="Tutorial steps"
      className="flex gap-1 overflow-x-auto border-b border-neutral-300 p-2 lg:flex-col lg:border-r lg:border-b-0 dark:border-neutral-700"
    >
      {lessons.map(([title], index) => (
        <Button
          key={title}
          className="shrink-0 justify-start whitespace-nowrap lg:whitespace-normal"
          variant={index === step ? "primary" : "ghost"}
          aria-current={index === step ? "step" : undefined}
          disabled={index > 0 && !done.slice(0, index).every(Boolean)}
          onClick={() => onStep(index)}
        >
          <span className="w-4 shrink-0">{done[index] ? "✓" : index + 1}</span>
          {title}
        </Button>
      ))}
    </nav>
  );
}

const renderDocument: ArtifactRenderer = (props) => (
  <TutorialDocument key={`${props.version.seq}:${props.path}`} {...props} />
);

function Practice({
  id,
  onVersion,
}: {
  id: string;
  onVersion: (id: string, seq: number | null) => void;
}) {
  const query = useQuery({ queryKey: ["artifact", id], queryFn: () => artifactApi.detail(id) });
  const changed = useCallback(
    (view: ArtifactLocation) => onVersion(id, view.versionSeq),
    [id, onVersion],
  );
  return query.data ? (
    <ArtifactWorkspace
      key={id}
      detail={query.data}
      initialSearch={artifactLocationSearch({
        versionSeq: 1,
        path: null,
        representation: query.data.kind === "diff" ? "diff" : "rendered",
      })}
      onLocationChange={changed}
      renderPreview={renderDocument}
    />
  ) : (
    <p className="p-6">Loading…</p>
  );
}

export function Tutorial() {
  useArtifactEvents();
  const client = useQueryClient();
  const [dark, toggleTheme] = useTheme();
  const { artifactId } = useRoute();
  const [step, setStep] = useState(0);
  const [published, setPublished] = useState(false);
  const [inspected, setInspected] = useState(false);
  const [visited, setVisited] = useState<string[]>([]);
  const [generation, setGeneration] = useState(0);
  const [cli, setCli] = useState(false);
  const query = useQuery({
    queryKey: ["artifact", primary],
    queryFn: () => artifactApi.detail(primary),
  });
  const note = query.data?.feedback.find(
    (note) => note.author.role === "human" && note.target.kind === "rendered",
  );
  const done = [
    published,
    !!note,
    !!note?.replies.some((reply) => reply.author.role === "agent"),
    inspected,
    note?.status === "resolved",
    samples.every((id) => visited.includes(id)),
  ];
  const count = done.filter(Boolean).length;
  const onVersion = useCallback((id: string, seq: number | null) => {
    if (id === primary && seq === 2) setInspected(true);
  }, []);
  useEffect(() => {
    if (published && artifactId)
      setVisited((current) => (current.includes(artifactId) ? current : [...current, artifactId]));
  }, [artifactId, published]);
  const reset = () => {
    resetPractice();
    client.clear();
    setStep(0);
    setPublished(false);
    setInspected(false);
    setVisited([]);
    setGeneration((n) => n + 1);
  };
  return (
    <div className="min-h-screen bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <AppHeader showSettings={false}>
        <h1 className="flex-1 text-sm font-semibold">Tutorial</h1>
        <Button onClick={() => setCli(!cli)}>CLI companion</Button>
        <Button onClick={toggleTheme}>Switch to {dark ? "light" : "dark"}</Button>
      </AppHeader>
      <div className="grid lg:grid-cols-[220px_minmax(0,1fr)]">
        <TutorialGuide step={step} done={done} onStep={setStep} />
        <main className="min-w-0">
          <section
            aria-label="Current lesson"
            className="space-y-3 border-b border-neutral-300 p-4 dark:border-neutral-700"
          >
            <div className="flex items-center gap-3 text-xs text-neutral-500">
              <span>Step {step + 1} of 6</span>
              <span className="flex-1" role="status">
                {count} / 6 complete
              </span>
              <Button onClick={reset}>Start over</Button>
            </div>
            <h2 className="text-xl font-semibold">{lessons[step][0]}</h2>
            <p className="max-w-3xl text-sm">{lessons[step][1]}</p>
            {done[step] && (
              <div className="flex items-center gap-3 text-sm text-success-700 dark:text-success-400">
                <span>
                  {count === 6
                    ? "Tutorial complete. Keep exploring or start again."
                    : "Step complete."}
                </span>
                {step < 5 && (
                  <Button variant="primary" onClick={() => setStep(step + 1)}>
                    Continue →
                  </Button>
                )}
              </div>
            )}
          </section>
          <div className="border-b border-neutral-300 px-4 py-2 text-xs text-neutral-500 dark:border-neutral-700">
            Practice workspace · scripted agent · changes stay in this tutorial
          </div>
          <section
            id="practice"
            aria-label="Practice workspace"
            key={generation}
            className="relative flex h-[780px] min-h-[560px] flex-col overflow-hidden border-b border-neutral-300 dark:border-neutral-700"
          >
            {!published ? (
              <div className="m-auto max-w-lg space-y-5 p-6">
                <h3 className="text-xl font-medium">Publish a complete directory</h3>
                <MessageProse
                  source={
                    "```text\nweekend-guide/\n├── index.html\n├── style.css\n└── landscape.svg\n```"
                  }
                />
                <p className="text-sm text-neutral-500">
                  Local edits become visible when the agent publishes a new version.
                </p>
                <Button
                  variant="primary"
                  onClick={() => {
                    setPublished(true);
                    navigate(`/${primary}`);
                  }}
                >
                  Publish sample
                </Button>
              </div>
            ) : artifactId ? (
              <Practice id={artifactId} onVersion={onVersion} />
            ) : (
              <>
                <AppHeader />
                <div className="min-h-0 flex-1 overflow-auto">
                  <ArtifactHome />
                </div>
              </>
            )}
          </section>
          {cli && (
            <section
              aria-label="CLI companion"
              className="border-b border-neutral-300 p-5 dark:border-neutral-700"
            >
              <MessageProse source={commands} />
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
