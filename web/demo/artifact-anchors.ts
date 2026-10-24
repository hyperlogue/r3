import type {
  ArtifactActor,
  ArtifactAnchorDestination,
  ArtifactAnchorResolution,
  ArtifactDocumentTarget,
  ArtifactReanchorBody,
  ArtifactReanchorResult,
  ArtifactThread,
} from "../../shared/artifacts.ts";
import type { AttachmentInput } from "../../shared/attachments.ts";
import { demo, fail, now } from "./artifact-backend.ts";

function rows(id: string, target: ArtifactDocumentTarget) {
  const publication = demo.publication(id, target.versionSeq);
  if (target.kind === "diff") {
    const file = publication.fullDiff.find(
      (file) => file.path === target.path || file.oldPath === target.path,
    );
    return (
      file?.lines.flatMap((row) => {
        const line = target.locator?.side === "old" ? row.oldLine : row.newLine;
        return line === null ? [] : [{ line, text: row.text }];
      }) ?? []
    );
  }
  return (
    publication.sources[target.path]?.lines.map((row) => ({ line: row.lineNo, text: row.text })) ??
    []
  );
}
export function prepareDemoAnchor(
  id: string,
  input: ArtifactAnchorDestination,
): ArtifactDocumentTarget {
  const target = structuredClone(input) as ArtifactDocumentTarget;
  if (!target || !["source", "rendered", "diff", "media"].includes(target.kind))
    fail("A re-anchor needs a native document destination");
  if (
    target.locator &&
    ["quote", "prefix", "suffix", "frame"].some((key) => key in target.locator!)
  )
    fail("Thread quotes are immutable; supply destination coordinates only");
  if ((target.kind === "source" || target.kind === "diff") && target.locator) {
    const { start, end } = target.locator;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 1 ||
      end < start ||
      end - start >= 100
    )
      fail("Invalid target range");
    const captured = rows(id, target).filter((row) => row.line >= start && row.line <= end);
    if (
      captured.length !== end - start + 1 ||
      captured.some((row, index) => row.line !== start + index)
    )
      fail("Range is not captured");
    target.locator.quote = captured
      .map((row) => row.text)
      .join("\n")
      .slice(0, 16384);
  }
  demo.target(id, target);
  return target;
}
export function checkDemoAnchor(
  thread: ArtifactThread,
  expectedSeq: number,
  expectedRevision: number,
) {
  const artifact = demo.requireActive(thread.artifactId);
  if (
    artifact.versions.at(-1)?.seq !== expectedSeq ||
    (thread.anchor?.revision ?? 0) !== expectedRevision
  )
    fail("Re-anchor conflict: publication or anchor changed", 409);
}
export function saveDemoAnchor(
  thread: ArtifactThread,
  target: ArtifactDocumentTarget,
  actor: ArtifactActor,
) {
  if (JSON.stringify(thread.anchor?.target ?? thread.target) === JSON.stringify(target))
    return { threadId: thread.id, revision: thread.anchor?.revision ?? 0, changed: false };
  const revision = (thread.anchor?.revision ?? 0) + 1;
  thread.anchor = {
    target: structuredClone(target),
    actor,
    revision,
    createdAt: thread.anchor?.createdAt ?? now(),
    updatedAt: now(),
  };
  return { threadId: thread.id, revision, changed: true };
}
const operations = new WeakMap<
  object,
  Map<string, { input: string; result: ArtifactReanchorResult }>
>();
export async function reanchorDemo(
  id: string,
  body: ArtifactReanchorBody,
  frame: (
    id: string,
    target: ArtifactDocumentTarget,
    snapshot?: AttachmentInput,
  ) => Promise<ArtifactDocumentTarget>,
): Promise<ArtifactReanchorResult> {
  if (
    !Array.isArray(body.items) ||
    !body.items.length ||
    body.items.length > 100 ||
    new Set(body.items.map((item) => item.threadId)).size !== body.items.length ||
    !body.operationKey
  )
    fail("Invalid re-anchor batch");
  let receipts = operations.get(demo.state);
  if (!receipts) {
    receipts = new Map();
    operations.set(demo.state, receipts);
  }
  const key = `${id}:${body.operationKey}`;
  const input = JSON.stringify(body);
  const replay = () => {
    const receipt = receipts!.get(key);
    if (receipt && receipt.input !== input) fail("Operation key reused", 409);
    return receipt?.result;
  };
  const previous = replay();
  if (previous) return structuredClone(previous);
  const prepared = [];
  for (const item of body.items) {
    const { note } = demo.note(item.threadId);
    if (note.artifactId !== id) fail("Thread belongs to a different artifact");
    if (!Number.isSafeInteger(item.expectedAnchorRevision) || item.expectedAnchorRevision < 0)
      fail("Invalid anchor revision");
    const target = prepareDemoAnchor(id, item.target);
    if (target.versionSeq !== body.expectedSeq) fail("Destination must name latest publication");
    prepared.push({
      note,
      target: await frame(id, target, item.mediaSnapshot),
      revision: item.expectedAnchorRevision,
    });
  }
  const concurrent = replay();
  if (concurrent) return structuredClone(concurrent);
  for (const item of prepared) {
    if (demo.note(item.note.id).note !== item.note) fail("Thread changed", 409);
    checkDemoAnchor(item.note, body.expectedSeq, item.revision);
  }
  const results = prepared.map((item) => saveDemoAnchor(item.note, item.target, body.actor));
  const result = { operationKey: body.operationKey, results };
  receipts.set(key, { input, result });
  if (results.some((item) => item.changed)) demo.changed(id);
  return structuredClone(result);
}
export function resolveDemoAnchor(id: string, versionSeq: number): ArtifactAnchorResolution {
  const { artifact, note } = demo.note(id);
  demo.publication(artifact.id, versionSeq);
  const saved = note.anchor?.target ?? note.target;
  const result: ArtifactAnchorResolution = {
    threadId: id,
    anchorRevision: note.anchor?.revision ?? 0,
    versionSeq,
    state: "unplaced",
    target: null,
  };
  if (!("path" in saved)) return result;
  const target = structuredClone({ ...saved, versionSeq });
  if (
    (saved.kind === "source" || saved.kind === "diff") &&
    saved.locator &&
    saved.versionSeq !== versionSeq
  ) {
    const wanted = rows(artifact.id, saved).filter(
      (row) => row.line >= saved.locator!.start && row.line <= saved.locator!.end,
    );
    const available = rows(artifact.id, target);
    const starts = available
      .filter(
        (row, index) =>
          wanted.length &&
          wanted.every(
            (item, offset) =>
              available[index + offset]?.text === item.text &&
              available[index + offset]?.line === row.line + offset,
          ),
      )
      .map((row) => row.line);
    if (starts.length !== 1) return { ...result, state: starts.length ? "ambiguous" : "unplaced" };
    if ((target.kind === "source" || target.kind === "diff") && target.locator) {
      target.locator.start = starts[0]!;
      target.locator.end = starts[0]! + wanted.length - 1;
    }
  } else if (saved.kind === "media") {
    const file = (seq: number) =>
      demo.publication(artifact.id, seq).files.find((file) => file.path === saved.path);
    if (!file(versionSeq) || file(saved.versionSeq)?.hash !== file(versionSeq)?.hash) return result;
  }
  try {
    demo.target(artifact.id, target);
  } catch {
    return result;
  }
  return { ...result, state: target.kind === "rendered" ? "runtime-required" : "anchored", target };
}
