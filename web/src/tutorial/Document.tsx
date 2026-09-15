import { useEffect, useRef, useState } from "react";
import type { ArtifactDocumentTarget } from "../../../shared/artifacts.ts";
import { demo } from "../../demo/artifact-backend.ts";
import { MessageProse, QuoteBubble } from "../components/Message.tsx";
import type { ArtifactRenderedPaneProps } from "../pages/ArtifactView.tsx";
import { Button, prefersReduced } from "../ui.tsx";

// Only the lesson's document content is a fixture. Workspace controls,
// conversations, source/diff rendering, and their actions are the real components.
// Render inline because a published artifact cannot create a nested preview frame.
export function TutorialDocument(props: ArtifactRenderedPaneProps) {
  const root = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<{
    target: ArtifactDocumentTarget;
    left: number;
    top: number;
  } | null>(null);
  const [packed, setPacked] = useState(false);
  const { path, version, commenting, onTarget, onFeedback, targets, jump } = props;
  useEffect(() => {
    if (!commenting) setPicked(null);
  }, [commenting]);
  useEffect(() => {
    if (!jump) return;
    const element = root.current?.querySelector<HTMLElement>(
      jump.locator?.selector || "[data-tutorial-document]",
    );
    element?.scrollIntoView({ block: "center" });
    const animation =
      !prefersReduced() &&
      element?.animate([{ outline: "2px solid #f59e0b" }, { outline: "2px solid transparent" }], {
        duration: 900,
      });
    return () => {
      if (animation) animation.cancel();
    };
  }, [jump]);
  const source = demo.publication(version.artifactId, version.seq).sources[path];
  const markdown = path.endsWith(".md");
  return (
    // The sample's identified prose elements support the rendered-target exercise.
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation comes from the focusable sample text button
    <div
      ref={root}
      data-tutorial-document
      className="relative min-h-80 bg-white p-6 text-neutral-900 md:p-10 dark:bg-neutral-950 dark:text-neutral-100"
      onClick={(event) => {
        if (!commenting || !(event.target instanceof Element)) return;
        const element = event.target.closest<HTMLElement>("[data-lesson-target]");
        if (!element) return;
        const rect = element.getBoundingClientRect();
        setPicked({
          left: rect.left + rect.width / 2,
          top: rect.top,
          target: {
            kind: "rendered",
            versionSeq: version.seq,
            path,
            locator: {
              selector: `#${element.id}`,
              quote: element.textContent?.trim(),
              route: "#",
              viewport: { width: innerWidth, height: innerHeight },
            },
          },
        });
      }}
    >
      {markdown ? (
        <MessageProse source={source?.lines.map((line) => line.text).join("\n") ?? ""} />
      ) : (
        <article className="mx-auto max-w-2xl space-y-6">
          <p className="text-xs uppercase tracking-widest text-neutral-500">
            A small weekend guide · publication {version.seq}
          </p>
          <h1 className="text-4xl font-semibold leading-tight">A little room to wander.</h1>
          <p className="text-lg">
            Leave the schedule open. Take the scenic path. Find something worth slowing down for.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              id="reading-time"
              data-lesson-target
              className={
                commenting
                  ? "cursor-crosshair outline outline-primary-500 outline-offset-4"
                  : "cursor-default"
              }
            >
              {version.seq === 1 ? 5 : 10} min read
            </button>
            {targets
              .filter(
                ({ target }) =>
                  target.kind === "rendered" &&
                  target.versionSeq === version.seq &&
                  target.path === path,
              )
              .map(({ feedbackId }) => (
                <Button
                  key={feedbackId}
                  aria-label="Open reading estimate feedback"
                  onClick={() => onFeedback(feedbackId)}
                >
                  ●
                </Button>
              ))}
          </div>
          <h2 className="text-xl font-medium">Your afternoon, unhurried</h2>
          <p>Start with a walk, stop for a warm drink, and leave a little space for a detour.</p>
          <Button onClick={() => setPacked(!packed)}>Add a picnic to the plan</Button>
          {packed && <p role="status">Picnic added. Leave room for something sweet.</p>}
        </article>
      )}
      {picked && commenting && (
        <QuoteBubble
          pos={{ left: picked.left, top: picked.top, text: "" }}
          label="Comment here"
          onQuote={() => {
            onTarget(picked.target);
            setPicked(null);
          }}
        />
      )}
    </div>
  );
}
