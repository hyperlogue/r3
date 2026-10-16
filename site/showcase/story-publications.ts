import { renderArtifactDocument } from "../../server/artifact-document.ts";
import { parseUnifiedDiff } from "../../server/git.ts";
import { highlightToLines, langForPath } from "../../server/highlight.ts";
import {
  highlightPatchFiles,
  renderStoredPatch,
  validateStoredPatch,
} from "../../server/patch-content.ts";
import type { ArtifactVersion } from "../../shared/artifacts.ts";
import type { DemoPublication } from "../../web/demo/artifact-model.ts";
import { sha256 } from "./captures.ts";

// Render at build time using the product's document and diff renderers. Only
// their immutable output enters the static browser bundle.
export async function storyPublications() {
  const publications: Record<string, DemoPublication> = {};
  const documents: Record<string, Record<string, string>> = {};
  const digest = (value: string) => sha256(Buffer.from(value));
  for (const scene of ["proposal", "code-review"] as const) {
    for (const seq of [1, 2]) {
      const id = `artifact_example_${scene}`;
      const key = `${id}/${seq}`;
      const proposal = scene === "proposal";
      const contents = {
        "proposal.md": `# A first win before an invitation\n\nFieldwork · Onboarding proposal · ${seq === 1 ? "Initial draft" : "Revised approach"}\n\n## First session\n\n${seq === 1 ? "1. Create an account.\n2. Invite your teammates.\n3. Create your first project.\n4. Add a milestone." : "1. Create a project on your own.\n2. Add your first milestone.\n3. See progress on your dashboard.\n4. Invite teammates when you are ready."}\n\n## Success looks like\n\n${seq === 1 ? "A team has joined and started its first project." : "A new user reaches a useful dashboard without waiting for anyone else."}\n\n## Rollout\n\nTry the flow with five new users. Watch where they pause.\n`,
        "research.md":
          "# Notes from five first sessions\n\nThree people were exploring alone. Two hesitated at the invitation step. Everyone wanted to see a useful project before bringing in colleagues.\n",
      };
      const patch =
        seq === 1
          ? "diff --git a/create-project.ts b/create-project.ts\n--- a/create-project.ts\n+++ b/create-project.ts\n@@ -1,3 +1,6 @@\n async function submitProject() {\n+  if (pending) return;\n+  setPending(true);\n   await createProject(values);\n+  setPending(false);\n }\n"
          : 'diff --git a/create-project.ts b/create-project.ts\n--- a/create-project.ts\n+++ b/create-project.ts\n@@ -1,3 +1,12 @@\n async function submitProject() {\n-  await createProject(values);\n+  if (pending) return;\n+  setPending(true);\n+  try {\n+    await createProject(values);\n+    showProject();\n+  } catch {\n+    showError("Could not create project. Try again.");\n+  } finally {\n+    setPending(false);\n+  }\n }\n';
      const common = {
        artifactId: id,
        seq,
        publicationKey: `${scene}-${seq}`,
        contentHash: digest(proposal ? JSON.stringify(contents) : patch),
        label: proposal
          ? seq === 1
            ? "Invite the team first"
            : "Reach a first win solo"
          : seq === 1
            ? "Prevent double submits"
            : "Recover after failure",
        summary: proposal
          ? "Review the first-session sequence and supporting research."
          : "Review the pending guard and request failure path.",
        publishedBy: { role: "agent" as const, sessionId: "demo-agent" },
        provenance: { demo: true },
        createdAt: "2026-09-11T12:00:00.000Z",
        publishedAt: "2026-09-11T12:00:00.000Z",
      };
      const version: ArtifactVersion = proposal
        ? { ...common, kind: "files", entrypoint: null, fileCount: 2 }
        : { ...common, kind: "diff", entrypoint: null, fileCount: null };
      const publication: DemoPublication = {
        version,
        files: [],
        sources: {},
        resources: {},
        diff: [],
        fullDiff: [],
        storageBlobs: {},
        patchBytes: 0,
      };
      documents[key] = {};
      if (proposal) {
        for (const [path, text] of Object.entries(contents)) {
          const hash = digest(text);
          const retained = await renderArtifactDocument(text, path);
          const language = langForPath(path);
          const highlighted = await highlightToLines(text, language, hash);
          const metadata = {
            path,
            hash,
            byteLength: Buffer.byteLength(text),
            mediaType: "text/markdown",
            renderedHash: digest(retained.html),
            rendererRevision: retained.revision,
          };
          publication.files.push(metadata);
          publication.sources[path] = {
            ...metadata,
            artifactId: id,
            versionSeq: seq,
            kind: "text",
            language,
            lines: text
              .trimEnd()
              .split("\n")
              .map((line, index) => ({ lineNo: index + 1, text: line, html: highlighted[index] })),
          };
          publication.resources[path] = Buffer.from(text).toString("base64");
          publication.storageBlobs[hash] = metadata.byteLength;
          publication.storageBlobs[metadata.renderedHash] = Buffer.byteLength(retained.html);
          documents[key][path] = retained.html;
        }
      } else {
        validateStoredPatch(patch);
        publication.fullDiff = parseUnifiedDiff(patch);
        await highlightPatchFiles(publication.fullDiff);
        publication.diff = await renderStoredPatch(patch);
        publication.patchBytes = Buffer.byteLength(patch);
      }
      publications[key] = publication;
    }
  }
  return { publications, documents };
}
