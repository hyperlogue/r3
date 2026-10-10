import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { ArtifactDetail } from "../../shared/artifacts.ts";
import { artifactApi } from "../../web/demo/artifact-api.ts";
import { demo } from "../../web/demo/artifact-backend.ts";
import { artifactDrafts } from "../../web/src/artifact-drafts.ts";
import { ArtifactPage } from "../../web/src/artifact-page.tsx";
import { setDiscussionMode } from "../../web/src/settings.ts";
import "../../web/src/showcase/forms.ts";
import { FieldworkDocument } from "./FieldworkDocument.tsx";
import { FIELDWORK_ID, fieldworkSeed, VISIBILITY_DISCUSSION } from "./fixture.ts";

// A normal ArtifactPage host: fixture data, fake handlers, one renderer. There
// are no bundler aliases, API routes, authentication, or server bootstrap here.
const seed = fieldworkSeed(demo.state);
const parameters = new URLSearchParams(location.search);
function clearDrafts() {
  artifactDrafts.clear(FIELDWORK_ID);
  artifactDrafts.pruneComments(FIELDWORK_ID, new Set());
}
clearDrafts();
demo.reset(seed);
setDiscussionMode("expanded");
let snapshot: ArtifactDetail | null = structuredClone(demo.get(FIELDWORK_ID));
const listeners = new Set<() => void>();
function refresh() {
  const value = demo.state.artifacts.find((item) => item.id === FIELDWORK_ID);
  snapshot = value ? structuredClone(value) : null;
  for (const listener of listeners) listener();
}
demo.subscribers.add(refresh);
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const data = {
  ...artifactApi,
  themeStyle: async (theme?: string) =>
    structuredClone(seed.themeStyles[theme ?? ""] ?? Object.values(seed.themeStyles)[0]!),
};
function Example() {
  const detail = useSyncExternalStore(subscribe, () => snapshot);
  const [generation, setGeneration] = useState(0);
  const reset = () => {
    demo.reset(seed);
    clearDrafts();
    refresh();
    setDiscussionMode("expanded");
    setGeneration((value) => value + 1);
  };
  return (
    <>
      <aside className="example-banner" aria-label="About this example">
        <span>
          <strong>Example Fieldwork</strong>
          <span className="example-explainer">
            {" "}
            · Real r3 interface. Fictional data and scripted agent.
          </span>
        </span>
        <span className="example-actions">
          {!parameters.has("embedded") && (
            <a
              href={`../index.html?theme=${parameters.get("theme") === "dark" ? "dark" : "light"}`}
            >
              ← Homepage
            </a>
          )}
          <button type="button" onClick={reset}>
            Reset example
          </button>
        </span>
      </aside>
      {detail ? (
        <ArtifactPage
          key={generation}
          detail={detail}
          data={data}
          actions={artifactApi}
          initialSearch={`?version=2&discussions=${VISIBILITY_DISCUSSION}&comment=comment_fieldwork_fix`}
          renderPreview={(props) => <FieldworkDocument {...props} />}
        />
      ) : (
        <main className="example-deleted">
          <p>Example deleted.</p>
          <button type="button" onClick={reset}>
            Start again
          </button>
        </main>
      )}
    </>
  );
}
const theme = (value: string) =>
  document.documentElement.classList.toggle("dark", value === "dark");
theme(new URLSearchParams(location.search).get("theme") ?? "light");
window.addEventListener("message", (event) => {
  if (
    event.source !== parent ||
    event.origin !== location.origin ||
    event.data?.type !== "r3-site-theme"
  )
    return;
  theme(event.data.theme);
});
createRoot(document.getElementById("root")!).render(<Example />);
