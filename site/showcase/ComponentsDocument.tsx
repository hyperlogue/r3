import { useEffect, useRef, useState } from "react";
import type { ArtifactRenderedPaneProps } from "../../web/src/artifact-page.tsx";

// A small authored component showcase inside the same real ArtifactPage host.
export function ComponentsDocument(props: ArtifactRenderedPaneProps) {
  const card = useRef<HTMLDivElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const [selected, setSelected] = useState(false);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (props.active === false || !props.jump) return;
    const found = props.jump.locator?.selector === "#component-action";
    if (found) action.current?.scrollIntoView({ block: "nearest" });
    props.onLocated?.(found ? "anchored" : "unplaced");
  }, [props.active, props.jump, props.onLocated]);
  return (
    <div className={`component-document ${props.commenting ? "component-commenting" : ""}`}>
      <div className="component-board">
        <p className="component-category">Gather / Components</p>
        <div className="component-card" ref={card}>
          <h1>Keep everyone in sync</h1>
          <p>A quick look at what’s happening across your team’s projects.</p>
          <button
            ref={action}
            type="button"
            id="component-action"
            style={{ marginTop: props.version.seq > 1 ? 16 : 8 }}
            className={`component-action ${(props.commenting && selected) || (props.jump && props.highlightLocated !== false) ? "component-selected" : ""}`}
            onClick={() => {
              if (!props.commenting) {
                setOpened(true);
                return;
              }
              setSelected(true);
              const target = {
                kind: "rendered" as const,
                versionSeq: props.version.seq,
                path: props.path,
                locator: { selector: "#component-action", label: "Card action button" },
              };
              const rect = card.current!.getBoundingClientRect();
              if (props.onSelection)
                props.onSelection(
                  target,
                  { left: rect.x + rect.width / 2, top: rect.top, bottom: rect.bottom },
                  false,
                );
              else props.onTarget(target);
            }}
          >
            View activity <span aria-hidden="true">→</span>
          </button>
          {!props.commenting &&
            props.targets.map(({ threadId, target }) =>
              target.kind === "rendered" && target.locator?.selector === "#component-action" ? (
                <button
                  key={threadId}
                  type="button"
                  className="component-pin"
                  aria-label="Open button spacing thread"
                  onClick={() => props.onThread(threadId)}
                >
                  1
                </button>
              ) : null,
            )}
          {opened && (
            <p className="component-status" role="status">
              You’re all caught up.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
