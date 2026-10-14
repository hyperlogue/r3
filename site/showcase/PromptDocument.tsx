import { useEffect, useRef, useState } from "react";
import type { ArtifactRenderedPaneProps } from "../../web/src/artifact-page.tsx";

export function PromptDocument(
  props: ArtifactRenderedPaneProps & { scene: "explainer" | "brief" },
) {
  const anchor = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(false);
  const [relevance, setRelevance] = useState(70);
  const [freshness, setFreshness] = useState(30);
  const explainer = props.scene === "explainer";
  const id = explainer ? "ranking-signals" : "onboarding-tradeoffs";
  const label = explainer ? "Ranking signals" : "Onboarding tradeoffs";
  const revised = props.version.seq > 1;
  useEffect(() => {
    if (props.active === false || !props.jump) return;
    const found = props.jump.locator?.selector === `#${id}`;
    if (found) anchor.current?.scrollIntoView({ block: "nearest" });
    props.onLocated?.(found ? "anchored" : "unplaced");
  }, [id, props.active, props.jump, props.onLocated]);
  const results = [
    {
      name: "Planning a product launch",
      match: 96,
      age: 25,
      detail: "Strong match · updated last month",
    },
    {
      name: "This week’s launch notes",
      match: 61,
      age: 98,
      detail: "Related topic · updated today",
    },
    {
      name: "The team’s release checklist",
      match: 79,
      age: 65,
      detail: "Good match · updated last week",
    },
  ]
    .map((result) => ({
      ...result,
      score: Math.round(
        (result.match * relevance + result.age * freshness) / Math.max(1, relevance + freshness),
      ),
    }))
    .sort((a, b) => b.score - a.score);
  return (
    <div className={`prompt-document prompt-document-${props.scene}`}>
      <div className="prompt-document-brand">
        <strong>▧ Fieldwork</strong>
        <span>{explainer ? "Learning lab / Search" : "Product notes / Onboarding"}</span>
      </div>
      <main className="prompt-document-body">
        <p className="prompt-document-eyebrow">
          {explainer ? "An explainer you can try" : "A decision, made clearer"}
        </p>
        <h1>{explainer ? "What rises to the top?" : "A good first five minutes."}</h1>
        <p className="prompt-document-intro">
          {explainer
            ? revised
              ? "Search is a balance. Move the signals and watch the order change."
              : "Search balances close matches with recent updates."
            : "Three ways to help a new team find its footing in Fieldwork."}
        </p>
        <div
          ref={anchor}
          id={id}
          className={`prompt-document-target ${selected || (props.jump && props.highlightLocated !== false) ? "fieldwork-located" : ""}`}
        >
          {explainer ? (
            <>
              {revised && (
                <div className="ranking-controls">
                  <label>
                    Relevance <output>{relevance}%</output>
                    <input
                      aria-label="Relevance weight"
                      type="range"
                      min="0"
                      max="100"
                      value={relevance}
                      onChange={(event) => setRelevance(Number(event.target.value))}
                    />
                  </label>
                  <label>
                    Freshness <output>{freshness}%</output>
                    <input
                      aria-label="Freshness weight"
                      type="range"
                      min="0"
                      max="100"
                      value={freshness}
                      onChange={(event) => setFreshness(Number(event.target.value))}
                    />
                  </label>
                </div>
              )}
              {revised && (
                <p className="prompt-document-note">
                  Relevance rewards a close match. Freshness rewards recent updates. Each score is
                  the weighted average of the two signals.
                </p>
              )}
              <div className="ranking-results" aria-live="polite">
                {results.map((result) => (
                  <div key={result.name}>
                    <span>
                      <strong>{result.name}</strong>
                      <small>{result.detail}</small>
                    </span>
                    <b>{result.score}</b>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="onboarding-options">
                {[
                  {
                    name: "Blank canvas",
                    tag: "Maximum freedom",
                    benefit: "No setup steps. Start with your own work.",
                    risk: "An empty workspace asks the team to invent its own structure.",
                  },
                  {
                    name: "Guided tour",
                    tag: "Clear instructions",
                    benefit: "Learn the controls in a short walkthrough.",
                    risk: "A tour delays the first useful action and is easy to skip.",
                  },
                  {
                    name: "Starter project",
                    tag: "Recommended",
                    benefit: "A useful example becomes the team’s first plan.",
                    risk: "Sample content needs clear labels and an easy way to start fresh.",
                  },
                ].map((flow, index) => (
                  <article key={flow.name} className={index === 2 ? "onboarding-recommended" : ""}>
                    <small>{flow.tag}</small>
                    <h2>{flow.name}</h2>
                    <p>{flow.benefit}</p>
                    {revised && (
                      <p className="onboarding-risk">
                        <strong>Tradeoff</strong>
                        {flow.risk}
                      </p>
                    )}
                  </article>
                ))}
              </div>
              {revised && (
                <p className="prompt-document-note">
                  <strong>For a small team:</strong> choose a starter project. Help them reach a
                  useful first plan before introducing every feature.
                </p>
              )}
            </>
          )}
          {props.commenting && (
            <button
              className="fieldwork-anchor"
              type="button"
              onClick={() => {
                setSelected(true);
                props.onTarget({
                  kind: "rendered",
                  versionSeq: props.version.seq,
                  path: props.path,
                  locator: { selector: `#${id}`, label },
                });
              }}
            >
              Comment on {label.toLowerCase()}
            </button>
          )}
          {!props.commenting &&
            props.targets.map(({ threadId, target }) =>
              target.kind === "rendered" && target.locator?.selector === `#${id}` ? (
                <button
                  key={threadId}
                  type="button"
                  className="fieldwork-pin"
                  aria-label={`Open ${label.toLowerCase()} thread`}
                  onClick={() => props.onThread(threadId)}
                >
                  1
                </button>
              ) : null,
            )}
        </div>
        <p className="prompt-document-footer">
          {explainer
            ? "A simplified model for exploring the idea."
            : "Decision brief · Product and design"}
        </p>
      </main>
    </div>
  );
}
