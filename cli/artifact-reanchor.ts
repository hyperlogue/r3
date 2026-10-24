import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ArtifactApiError, artifactApiPath, threadApiPath } from "../shared/artifact-client.ts";
import type {
  ArtifactActor,
  ArtifactAnchorDestination,
  ArtifactReanchorBody,
  ArtifactReanchorResult,
  ArtifactThread,
} from "../shared/artifacts.ts";
import { type ArtifactArgs, ArtifactCommandError } from "./artifact-args.ts";
import type { ArtifactCommandContext } from "./artifact-commands.ts";
import { readAttachmentFiles } from "./attachment-files.ts";

export const quoteArgument = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

export function anchorDestination(args: ArtifactArgs): ArtifactAnchorDestination {
  if (args.has("quote"))
    throw new ArtifactCommandError(
      "Thread quotes are immutable; re-anchor with destination coordinates only",
    );
  if (args.has("target")) {
    try {
      return JSON.parse(args.require("target"));
    } catch {
      throw new ArtifactCommandError("--target must be JSON");
    }
  }
  const kind = args.require("view");
  const path = args.require("file");
  const versionSeq = args.sequence();
  if (kind === "rendered") {
    if (args.has("line") || args.has("side"))
      throw new ArtifactCommandError("Rendered destinations use selectors");
    if (args.has("route") && !args.has("selector"))
      throw new ArtifactCommandError("--route needs --selector");
    return {
      kind,
      path,
      versionSeq,
      locator: args.has("selector")
        ? { selector: args.require("selector"), route: args.value("route") }
        : null,
    };
  }
  if (kind !== "source" && kind !== "diff")
    throw new ArtifactCommandError("Use --view source|rendered|diff, or --target JSON for media");
  if (args.has("selector") || args.has("route") || (kind === "source" && args.has("side")))
    throw new ArtifactCommandError("Incompatible destination flags");
  if (!args.has("line")) return { kind, path, versionSeq, locator: null };
  const range = /^(\d+)(?:-(\d+))?$/.exec(args.require("line"));
  if (!range) throw new ArtifactCommandError("--line requires a line or start-end range");
  const locator = { start: Number(range[1]), end: Number(range[2] ?? range[1]) };
  if (kind === "source") return { kind, path, versionSeq, locator };
  const side = args.value("side") ?? "new";
  if (side !== "old" && side !== "new") throw new ArtifactCommandError("--side must be old or new");
  return { kind, path, versionSeq, locator: { ...locator, side } };
}

export async function reanchorCommand(
  args: ArtifactArgs,
  ctx: ArtifactCommandContext,
  actor: ArtifactActor,
): Promise<ArtifactReanchorResult> {
  let artifactId: string;
  let items: ArtifactReanchorBody["items"];
  let expectedSeq: number;
  if (args.has("artifact")) {
    if (
      [
        "target",
        "file",
        "view",
        "line",
        "selector",
        "side",
        "route",
        "frame",
        "expected-anchor",
      ].some((name) => args.has(name))
    )
      throw new ArtifactCommandError("Bulk destinations and revisions belong in --input JSON");
    artifactId = args.require("artifact");
    expectedSeq = args.sequence();
    const input = args.require("input");
    try {
      items = JSON.parse(
        input === "-" ? await ctx.stdin() : await Bun.file(resolve(ctx.cwd, input)).text(),
      );
    } catch {
      throw new ArtifactCommandError("--input must contain a JSON array of re-anchor entries");
    }
  } else {
    if (args.has("input")) throw new ArtifactCommandError("--input requires --artifact");
    const target = anchorDestination(args);
    const thread = await ctx.client.json<ArtifactThread>("GET", threadApiPath(args.id()));
    if (!Object.hasOwn(thread, "anchor"))
      throw new ArtifactCommandError(
        "This backend does not support thread re-anchoring. Upgrade the backend before retrying.",
      );
    artifactId = thread.artifactId;
    expectedSeq = target.versionSeq;
    if (args.has("version") && args.sequence() !== expectedSeq)
      throw new ArtifactCommandError("--version and --target disagree");
    items = [
      {
        threadId: thread.id,
        target,
        expectedAnchorRevision: args.has("expected-anchor")
          ? args.sequence("expected-anchor", true)
          : (thread.anchor?.revision ?? 0),
        ...(args.has("frame")
          ? { mediaSnapshot: (await readAttachmentFiles([args.require("frame")], ctx.cwd))[0] }
          : {}),
      },
    ];
  }
  const operationKey = args.value("key") ?? randomUUID();
  try {
    return await ctx.client.json("POST", `${artifactApiPath(artifactId)}/thread-anchors`, {
      actor,
      expectedSeq,
      operationKey,
      items,
    } satisfies ArtifactReanchorBody);
  } catch (error) {
    // These are literal flag values, never shell commands executed by r3.
    if (error instanceof ArtifactApiError && error.message.includes("Operation key"))
      ctx.error(
        "This key belongs to an earlier prepared request. Reuse its original input and guards; inspect the saved result before choosing a fresh key.",
      );
    else
      ctx.error(
        `Re-anchor not confirmed. Retry unchanged input with --key=${quoteArgument(operationKey)}${args.has("artifact") ? " and the original JSON revisions" : ` --expected-anchor=${items[0]!.expectedAnchorRevision}`} and the same destination version.`,
      );
    throw error;
  }
}
