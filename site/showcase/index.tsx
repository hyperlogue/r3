import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { ArtifactDetail } from "../../shared/artifacts.ts";
import { artifactApi } from "../../web/demo/artifact-api.ts";
import { demo } from "../../web/demo/artifact-backend.ts";
import { artifactDrafts } from "../../web/src/artifact-drafts.ts";
import { ArtifactPage } from "../../web/src/artifact-page.tsx";
import { initializeLocale, useLocale } from "../../web/src/i18n.ts";
import { setDiscussionMode } from "../../web/src/settings.ts";
import { t } from "../i18n.ts";
import "../../web/src/showcase/forms.ts";
import { ComponentsDocument } from "./ComponentsDocument.tsx";
import { FieldworkDocument } from "./FieldworkDocument.tsx";
import { componentsSeed, fieldworkSeed } from "./fixture.ts";
import { mediaFrames, mediaSeed } from "./media-fixture.ts";
import { PromptDocument } from "./PromptDocument.tsx";
import { storyDocument } from "./story-document.ts";
import { storySeed } from "./story-fixture.ts";

// A normal ArtifactPage host: fixture data, fake handlers, one renderer. There
// are no bundler aliases, API routes, authentication, or server bootstrap here.
const parameters = new URLSearchParams(location.search);
const scene = parameters.get("scene");
const promptScene = scene === "explainer" || scene === "brief" ? scene : "prototype";
const componentScene = scene === "components";
const mediaScene = scene === "media" || scene === "media-video";
const storyScene = scene === "proposal" || scene === "code-review";
const seed = storyScene
  ? storySeed(demo.state, scene)
  : mediaScene
    ? mediaSeed(demo.state, scene === "media-video")
    : componentScene
      ? componentsSeed(demo.state)
      : fieldworkSeed(demo.state, promptScene);
const artifactId = seed.artifacts[0]!.id;
function clearDrafts() {
  artifactDrafts.clear(artifactId);
  artifactDrafts.pruneComments(artifactId, new Set());
}
clearDrafts();
demo.reset(seed);
function restoreMediaFrames() {
  if (mediaScene) for (const [id, value] of mediaFrames()) demo.images.set(id, value);
}
restoreMediaFrames();
setDiscussionMode("expanded");
let snapshot: ArtifactDetail | null = structuredClone(demo.get(artifactId));
const listeners = new Set<() => void>();
function refresh() {
  const value = demo.state.artifacts.find((item) => item.id === artifactId);
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
  const locale = useLocale();
  const detail = useSyncExternalStore(subscribe, () => snapshot);
  const [generation, setGeneration] = useState(0);
  const reset = () => {
    demo.reset(seed);
    restoreMediaFrames();
    clearDrafts();
    refresh();
    setDiscussionMode("expanded");
    setGeneration((value) => value + 1);
  };
  return (
    <>
      {!parameters.has("embedded") && (
        <aside className="example-banner" aria-label={t("About this example")}>
          <span>
            <strong>{componentScene ? t("UI component showcase") : "Example Fieldwork"}</strong>
            <span className="example-explainer">
              {" "}
              {t("· Real r3 interface. Fictional data and scripted agent.")}
            </span>
          </span>
          <span className="example-actions">
            <a
              href={`../${locale === "zh-cn" ? "zh-cn/" : ""}index.html?theme=${parameters.get("theme") === "dark" ? "dark" : "light"}`}
            >
              {t("← Homepage")}
            </a>
            <button type="button" onClick={reset}>
              {t("Reset example")}
            </button>
          </span>
        </aside>
      )}
      {detail ? (
        <ArtifactPage
          key={generation}
          detail={detail}
          data={data}
          actions={artifactApi}
          initialSearch={
            storyScene
              ? `?version=1&file=${scene === "proposal" ? "proposal.md" : "create-project.ts"}&thread=${seed.artifacts[0]!.threads[0]!.id}`
              : mediaScene
                ? `?version=1&file=${scene === "media-video" ? "launch.webm" : "launch.png"}&thread=thread_launch_${scene === "media-video" ? "video" : "image"}`
                : componentScene
                  ? "?version=2"
                  : `?version=2&thread=${seed.artifacts[0]!.threads[0]!.id}&comment=comment_fieldwork_fix`
          }
          renderPreview={(props) =>
            storyScene ? (
              scene === "proposal" ? (
                <ComponentsDocument
                  {...props}
                  document={storyDocument}
                  title="Onboarding proposal"
                />
              ) : null
            ) : mediaScene ? null : componentScene ? (
              <ComponentsDocument {...props} />
            ) : promptScene === "prototype" ? (
              <FieldworkDocument {...props} />
            ) : (
              <PromptDocument {...props} scene={promptScene} />
            )
          }
        />
      ) : (
        <main className="example-deleted">
          <p>{t("Example deleted.")}</p>
          <button type="button" onClick={reset}>
            {t("Start again")}
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
initializeLocale();
createRoot(document.getElementById("root")!).render(<Example />);
