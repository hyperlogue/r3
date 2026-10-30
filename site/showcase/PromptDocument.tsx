import { useState } from "react";

export function PromptDocument({
  scene,
  revised,
}: {
  scene: "explainer" | "brief";
  revised: boolean;
}) {
  const [relevance, setRelevance] = useState(70);
  const [freshness, setFreshness] = useState(30);
  const explainer = scene === "explainer";
  const id = explainer ? "ranking-signals" : "access-rules";
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
    <div className={`prompt-document prompt-document-${scene}`}>
      <div className="prompt-document-brand">
        <strong>{explainer ? "∿ Search lab" : "Fieldwork / Engineering"}</strong>
        <span>{explainer ? "Interactive lesson 03" : "Design proposals / RFC 014"}</span>
      </div>
      <main className="prompt-document-body">
        <p className="prompt-document-eyebrow">
          {explainer ? "Turn the signals. See the difference." : "RFC 014 · Design proposal"}
        </p>
        <h1>{explainer ? "What rises to the top?" : "Project visibility & access"}</h1>
        <p className="prompt-document-intro">
          {explainer
            ? revised
              ? "Search is a balance. Move the signals and watch the order change."
              : "Search balances close matches with recent updates."
            : "A predictable access model for shared and private work."}
        </p>
        {!explainer && (
          <>
            <dl className="design-doc-meta">
              <div>
                <dt>Status</dt>
                <dd>
                  <span>In review</span>
                </dd>
              </div>
              <div>
                <dt>Owner</dt>
                <dd>Product engineering</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>11 Sep 2026</dd>
              </div>
            </dl>
            <section className="design-doc-section">
              <h2>Context</h2>
              <p>
                Teams need a shared place to work, but early plans often need a smaller audience.
                Today, project access is implicit. People cannot tell who can discover their work.
              </p>
            </section>
          </>
        )}
        <div id={id} className="prompt-document-target">
          {explainer ? (
            <>
              <div className="ranking-query">
                <span>Search query</span>
                <code>product launch</code>
                <span aria-hidden="true">↵</span>
              </div>
              {revised && (
                <div className="ranking-controls">
                  <label>
                    <span className="ranking-signal ranking-signal-relevance">Relevance</span>{" "}
                    <output>{relevance}%</output>
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
                    <span className="ranking-signal ranking-signal-freshness">Freshness</span>{" "}
                    <output>{freshness}%</output>
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
              <div className="ranking-results-heading">
                <span>Live results</span>
                <span>Score / 100</span>
              </div>
              <div className="ranking-results" aria-live="polite">
                {results.map((result, index) => (
                  <div key={result.name}>
                    <span className="ranking-position">0{index + 1}</span>
                    <span className="ranking-result-detail">
                      <strong>{result.name}</strong>
                      <small>{result.detail}</small>
                      <span className="ranking-bar" aria-hidden="true">
                        <i
                          style={{
                            width: `${(result.match * relevance) / Math.max(1, relevance + freshness)}%`,
                          }}
                        />
                        <i
                          style={{
                            width: `${(result.age * freshness) / Math.max(1, relevance + freshness)}%`,
                          }}
                        />
                      </span>
                    </span>
                    <b>{result.score}</b>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <section className="design-doc-section design-doc-decision">
              <h2>Proposed access model</h2>
              <p>
                Offer two visibility settings at creation: <strong>Workspace</strong> for shared
                work and <strong>Private</strong> for invited members only. Show the audience beside
                the setting before the project is created.
              </p>
              {revised && (
                <p className="prompt-document-note">
                  <strong>When visibility changes.</strong> Invited members keep access. Switching
                  to private immediately removes access for everyone else, including through
                  existing shared links. Check permissions on every request.
                </p>
              )}
            </section>
          )}
        </div>
        {!explainer && (
          <>
            <section className="design-doc-section">
              <h2>Alternatives & tradeoffs</h2>
              <table className="design-doc-table">
                <thead>
                  <tr>
                    <th>Approach</th>
                    <th>Tradeoff</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      Workspace or private <span>Proposed</span>
                    </td>
                    <td>Clear audience; no custom roles in v1.</td>
                  </tr>
                  <tr>
                    <td>Per-person permissions</td>
                    <td>More control, more setup and maintenance.</td>
                  </tr>
                  <tr>
                    <td>Anyone with a link</td>
                    <td>Easy sharing, unpredictable audience.</td>
                  </tr>
                </tbody>
              </table>
            </section>
            <section className="design-doc-section">
              <h2>Rollout & open questions</h2>
              <p>
                Keep existing projects workspace-visible. Trial the setting with five teams before
                general release. Confirm whether guests need access in the first iteration.
              </p>
            </section>
          </>
        )}
        <p className="prompt-document-footer">
          {explainer
            ? "A simplified model for exploring the idea."
            : "RFC 014 · Feedback requested on access rules and guest support"}
        </p>
      </main>
    </div>
  );
}
