import { createHash } from "node:crypto";
import { join } from "node:path";
import { renderArtifactDocument } from "../server/artifact-document.ts";
import { parseUnifiedDiff } from "../server/git.ts";
import { highlightToLines, langForPath, listThemes, themeStyle } from "../server/highlight.ts";
import {
  highlightPatchFiles,
  renderStoredPatch,
  validateStoredPatch,
} from "../server/patch-content.ts";
import {
  type ArtifactDetail,
  type ArtifactKind,
  type ArtifactVersion,
  isUnhandledArtifactFeedback,
} from "../shared/artifacts.ts";
import type { ArtifactDemoSeed, DemoPublication } from "../web/demo/artifact-model.ts";
import { demoStorageUsage, publicationKey } from "../web/demo/artifact-model.ts";

const previews: Record<string, { contentHash: string; documents: Record<string, string> }> = {};

const time = "2026-09-11T12:00:00.000Z";
const actor = { role: "agent" as const, sessionId: "demo-agent" };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const project = {
  id: "project_demo",
  name: "Publication workshop",
  remoteUrl: null,
  createdAt: time,
};
function artifact(id: string, kind: ArtifactKind, title: string): ArtifactDetail {
  return {
    id,
    kind,
    state: "active",
    projectId: project.id,
    title,
    meta: {},
    createdBy: actor,
    nextSeq: 2,
    createdAt: time,
    updatedAt: time,
    archivedAt: null,
    watching: true,
    working: false,
    unhandledCount: 0,
    storage: { totalBytes: 0, latestVersionBytes: 0 },
    legacy: null,
    versions: [],
    feedback: [],
    placements: [],
    events: [],
  };
}
function version(
  id: string,
  seq: number,
  kind: ArtifactKind,
  contentHash: string,
  count: number | null,
): ArtifactVersion {
  const shared = {
    artifactId: id,
    seq,
    publicationKey: `demo-${seq}`,
    contentHash,
    label: seq === 1 ? "Initial publication" : "Clearer behavior",
    summary:
      seq === 1
        ? "Select a line to start a conversation. Submit feedback to see a scripted agent reply and publish the next version."
        : "The scripted agent published this complete version. Earlier content and native feedback targets remain available.",
    publishedBy: actor,
    provenance: { demo: true },
    createdAt: time,
    publishedAt: time,
  };
  return kind === "diff"
    ? { ...shared, kind, entrypoint: null, fileCount: null }
    : kind === "html"
      ? { ...shared, kind, entrypoint: "index.html", fileCount: count! }
      : { ...shared, kind, entrypoint: null, fileCount: count! };
}
async function files(
  id: string,
  seq: number,
  contents: Record<string, string>,
  kind: "files" | "html" = "files",
): Promise<DemoPublication> {
  const result: DemoPublication = {
    version: version(id, seq, kind, hash(JSON.stringify(contents)), Object.keys(contents).length),
    files: [],
    sources: {},
    resources: {},
    diff: [],
    fullDiff: [],
    storageBlobs: {},
    patchBytes: 0,
  };
  const documents: Record<string, string> = {};
  for (const [path, text] of Object.entries(contents)) {
    const digest = hash(text);
    const language = langForPath(path);
    const lines = await highlightToLines(text, language, digest);
    const markdown = path.endsWith(".md");
    const retained = markdown ? await renderArtifactDocument(text, path) : null;
    const metadata = {
      path,
      mediaType: markdown
        ? "text/markdown"
        : path.endsWith(".html")
          ? "text/html"
          : path.endsWith(".css")
            ? "text/css"
            : path.endsWith(".svg")
              ? "image/svg+xml"
              : "text/plain",
      hash: digest,
      byteLength: Buffer.byteLength(text),
      renderedHash: retained ? hash(retained.html) : null,
      rendererRevision: retained?.revision ?? null,
    };
    if (retained) documents[path] = retained.html;
    else if (path.endsWith(".html")) documents[path] = text;
    result.files.push(metadata);
    result.storageBlobs[digest] = metadata.byteLength;
    if (retained) result.storageBlobs[metadata.renderedHash!] = Buffer.byteLength(retained.html);
    result.resources[path] = Buffer.from(text).toString("base64");
    const source = text.split("\n");
    if (text.endsWith("\n")) source.pop();
    result.sources[path] = {
      artifactId: id,
      versionSeq: seq,
      ...metadata,
      kind: "text",
      language,
      lines: source.map((text, index) => ({ lineNo: index + 1, text, html: lines[index] })),
    };
  }
  previews[publicationKey(id, seq)] = { contentHash: result.version.contentHash, documents };
  return result;
}
async function diff(id: string, seq: number, patch: string): Promise<DemoPublication> {
  validateStoredPatch(patch);
  const fullDiff = parseUnifiedDiff(patch);
  await highlightPatchFiles(fullDiff);
  return {
    version: version(id, seq, "diff", hash(patch), null),
    files: [],
    sources: {},
    resources: {},
    diff: await renderStoredPatch(patch),
    fullDiff,
    storageBlobs: {},
    patchBytes: Buffer.byteLength(patch),
  };
}
const docs = artifact("artifact_documents", "files", "Design a published workspace");
const code = artifact("artifact_code", "diff", "Keep feedback on its original version");
const firstDocs = await files(docs.id, 1, {
  "index.md":
    "# Published workspace\n\nAn artifact is a directory of files.\n\n## Versions\n\nAn agent publishes a complete directory after revising it.\nThe user can switch between published versions.\n\n## Feedback\n\nSelect source text to discuss a specific part of a document.\nReplies stay in the same thread.\n",
  "decisions.txt":
    "Files remain available when the publisher is offline.\nEach publication retains its own path membership.\nThe human decides when feedback is resolved.\n",
});
const nextDocs = await files(docs.id, 2, {
  "index.md":
    "# Published workspace\n\nAn artifact is a complete, versioned directory of files.\n\n## Versions\n\nAn agent publishes a complete directory after revising it.\nThe user can switch between published versions.\nPublishing does not change the version the user is reading.\n\n## Feedback\n\nSelect source text to discuss a specific part of a document.\nReplies stay in the same thread.\nLocate original returns to the publication where the thread began.\n",
  "decisions.txt":
    "Files remain available when the publisher is offline.\nEach publication retains its own path membership.\nThe human decides when feedback is resolved.\nRendered selections and source selections keep separate native targets.\n",
});
const html = artifact("artifact_weekend", "html", "Curve lab — a little closer");
const samplePaths = ["index.html", "details.html", "style.css"];
const curveScript = await Bun.file(
  join(import.meta.dir, "../web/demo/samples/curve-lab.js"),
).text();
async function curveLab(seq: number) {
  const contents = Object.fromEntries(
    await Promise.all(
      samplePaths.map(async (path) => [
        path,
        (await Bun.file(join(import.meta.dir, "../web/demo/samples", path)).text())
          .replaceAll("DEMO_VERSION", String(seq))
          .replaceAll(
            "DEMO_MODEL_NOTE",
            seq === 1
              ? "Can this model capture every ripple?"
              : "The small cosine ripple is outside this model; a close fit still has residual error.",
          )
          .replace("<script data-demo-script></script>", () => `<script>${curveScript}</script>`),
      ]),
    ),
  );
  return files(html.id, seq, contents, "html");
}
const firstHtml = await curveLab(1);
const nextHtml = await curveLab(2);
const firstDiff = await diff(
  code.id,
  1,
  "diff --git a/navigation.ts b/navigation.ts\n--- a/navigation.ts\n+++ b/navigation.ts\n@@ -1,3 +1,5 @@\n export function selectedVersion(versions: number[], current: number | null) {\n-  return current;\n+  // Prefer the newest publication.\n+  const latest = versions.at(-1) ?? null;\n+  return latest;\n }\n" +
    (await Bun.file(join(import.meta.dir, "../web/demo/samples/review-v1.patch")).text()),
);
const nextDiff = await diff(
  code.id,
  2,
  "diff --git a/navigation.ts b/navigation.ts\n--- a/navigation.ts\n+++ b/navigation.ts\n@@ -1,5 +1,6 @@\n export function selectedVersion(versions: number[], current: number | null) {\n-  // Prefer the newest publication.\n+  // Keep the reader on their selected publication.\n+  if (current !== null && versions.includes(current)) return current;\n   const latest = versions.at(-1) ?? null;\n   return latest;\n }\n" +
    (await Bun.file(join(import.meta.dir, "../web/demo/samples/review-v2.patch")).text()),
);
for (const [item, content] of [
  [docs, firstDocs],
  [code, firstDiff],
  [html, firstHtml],
] as const) {
  item.versions = [content.version];
  item.storage = demoStorageUsage([content]);
  item.feedback = [
    {
      id: `feedback_${item.id}`,
      artifactId: item.id,
      author: actor,
      body:
        item.kind === "html"
          ? "Try the parameter sliders and compare the residual error. Can the approximation capture the small ripple? Send a note to see a closer starting fit in version 2."
          : item.kind === "files"
            ? "Start with the version behavior in index.md. Select any line to ask a question or request a change."
            : "Does choosing the newest publication here preserve the reader’s selected version?",
      status: "open",
      target:
        item.kind === "html"
          ? {
              kind: "rendered",
              versionSeq: 1,
              path: "index.html",
              locator: {
                selector: "#model-note",
                quote: "Can this model capture every ripple?",
                route: "#",
              },
            }
          : item.kind === "files"
            ? {
                kind: "source",
                versionSeq: 1,
                path: "index.md",
                locator: {
                  start: 8,
                  end: 8,
                  quote: "The user can switch between published versions.",
                },
              }
            : {
                kind: "diff",
                versionSeq: 1,
                path: "navigation.ts",
                locator: { side: "new", start: 4, end: 4, quote: "  return latest;" },
              },
      legacy: null,
      createdAt: time,
      updatedAt: time,
      sentAt: time,
      statusUnsent: false,
      replies: [],
      claim: null,
    },
  ];
}
for (const item of [docs, code, html])
  item.unhandledCount = item.feedback.filter(isUnhandledArtifactFeedback).length;
const themes = listThemes();
const palette = (await themeStyle()).css;
const themeStyles = Object.fromEntries(
  await Promise.all(
    themes.map(async (theme) => [theme.id, { ...(await themeStyle(theme.id)), css: palette }]),
  ),
);
const seed: ArtifactDemoSeed = {
  artifacts: [html, code],
  projects: [project],
  publications: {
    [publicationKey(html.id, 1)]: firstHtml,
    [publicationKey(code.id, 1)]: firstDiff,
  },
  pending: { [html.id]: nextHtml, [code.id]: nextDiff },
  themes,
  themeStyles,
};
await Bun.write(
  join(import.meta.dir, "../web/demo/artifact-fixtures.gen.ts"),
  `// GENERATED by scripts/gen-artifact-demo.ts.\nimport type { ArtifactDemoSeed } from "./artifact-model.ts";\nexport const ARTIFACT_DEMO_SEED = ${JSON.stringify(seed)} as ArtifactDemoSeed;\nexport const ARTIFACT_WORKSHOP_SEED = { ...ARTIFACT_DEMO_SEED, artifacts: [${JSON.stringify(docs)}, ...ARTIFACT_DEMO_SEED.artifacts], publications: { ...ARTIFACT_DEMO_SEED.publications, [${JSON.stringify(publicationKey(docs.id, 1))}]: ${JSON.stringify(firstDocs)} }, pending: { ...ARTIFACT_DEMO_SEED.pending, [${JSON.stringify(docs.id)}]: ${JSON.stringify(nextDocs)} } } as ArtifactDemoSeed;\nexport const ARTIFACT_DEMO_PREVIEWS: Record<string, { contentHash: string; documents: Record<string, string> }> = ${JSON.stringify(previews)};\n`,
);
console.log("Generated curve lab and multi-file diff demos, with separate workshop fixtures.");
