import { useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { ArtifactDetail } from "../../shared/artifacts.ts";
import { artifactApi } from "../../web/demo/artifact-api.ts";
import { demo } from "../../web/demo/artifact-backend.ts";
import { DemoArtifactPreview } from "../../web/demo/artifact-renderer.tsx";
import { artifactDrafts } from "../../web/src/artifact-drafts.ts";
import { ArtifactPage } from "../../web/src/artifact-page.tsx";
import { initializeLocale, useLocale } from "../../web/src/i18n.ts";
import { setDiscussionMode } from "../../web/src/settings.ts";
import { t } from "../i18n.ts";
import "../../web/src/showcase/forms.ts";
import { ComponentsDocument } from "./ComponentsDocument.tsx";
import { componentsSeed, fieldworkSeed } from "./fixture.ts";
import { mediaFrames, mediaSeed } from "./media-fixture.ts";
import { examplePreview } from "./preview-fixtures.ts";
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
        <aside className="example-banner" aria-label={t("common.aboutThisExample")}>
          <span>
            <strong>
              {componentScene ? t("common.uiComponentShowcase") : "Example Fieldwork"}
            </strong>
            <span className="example-explainer">
              {" "}
              {t("common.realR3InterfaceFictionalDataAndScripted")}
            </span>
          </span>
          <span className="example-actions">
            <a
              href={`../${locale === "zh-cn" ? "zh-cn/" : ""}index.html?theme=${parameters.get("theme") === "dark" ? "dark" : "light"}`}
            >
              {t("common.homepage")}
            </a>
            <button type="button" onClick={reset}>
              {t("common.resetExample")}
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
          initialView={{
            versionSeq: storyScene || mediaScene ? 1 : 2,
            path: storyScene
              ? scene === "proposal"
                ? "proposal.md"
                : "create-project.ts"
              : mediaScene
                ? scene === "media-video"
                  ? "launch.webm"
                  : "launch.png"
                : null,
            representation:
              storyScene && scene !== "proposal" ? "source" : mediaScene ? "media" : "rendered",
            threadId: componentScene ? null : seed.artifacts[0]!.threads[0]!.id,
          }}
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
            ) : (
              <DemoArtifactPreview {...props} loadPreview={examplePreview} />
            )
          }
        />
      ) : (
        <main className="example-deleted">
          <p>{t("common.exampleDeleted")}</p>
          <button type="button" onClick={reset}>
            {t("common.startAgain")}
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
