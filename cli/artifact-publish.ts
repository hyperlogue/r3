import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { validatePublication } from "../server/publication.ts";
import { type ArtifactClient, artifactApiPath } from "../shared/artifact-client.ts";
import type {
  Artifact,
  ArtifactActor,
  ArtifactDetail,
  ArtifactKind,
  ArtifactVersion,
  PublishArtifactBody,
} from "../shared/artifacts.ts";
import { type ArtifactArgs, ArtifactCommandError } from "./artifact-args.ts";
import { captureFiles } from "./capture.ts";
import { captureGitCommit, captureGitDiff, captureGitFiles } from "./capture-git.ts";
import { detectPublisherRemote } from "./publisher-remote.ts";

export interface PublicationCommandContext {
  client: ArtifactClient;
  actor: ArtifactActor;
  cwd: string;
  stdin: () => Promise<string>;
  text: (name: string) => Promise<string | undefined>;
  error: (text: string) => void;
}

async function capture(
  args: ArtifactArgs,
  kind: ArtifactKind,
  ctx: PublicationCommandContext,
): Promise<PublishArtifactBody["content"]> {
  const choices = ["dir", "ref", "stdin-diff", "working", "staged", "commit", "diff"].filter(
    (name) => args.has(name),
  );
  if (choices.length !== 1)
    throw new ArtifactCommandError(
      "Choose exactly one capture flag: --dir, --ref, --stdin-diff, --working, --staged, --commit, or --diff",
    );
  if (kind === "diff") {
    if (args.has("dir") || args.has("ref") || args.has("file"))
      throw new ArtifactCommandError("Diff artifacts accept a complete independent patch");
    let patch: string;
    if (args.has("stdin-diff")) patch = await ctx.stdin();
    else if (args.has("commit")) patch = await captureGitCommit(ctx.cwd, args.require("commit"));
    else {
      let base = "HEAD";
      let head = args.has("staged") ? "STAGED" : "WORKING";
      if (args.has("diff")) {
        const match = /^(.+?)\.\.([^.].*)$/.exec(args.require("diff"));
        if (!match) throw new ArtifactCommandError("--diff requires base..head");
        [, base, head] = match;
      }
      patch = await captureGitDiff(ctx.cwd, base, head);
    }
    return { kind, patch };
  }
  if (!args.has("dir") && !args.has("ref"))
    throw new ArtifactCommandError("File and HTML artifacts require --dir or --ref with --file");
  const files = args.has("ref")
    ? await captureGitFiles(ctx.cwd, args.require("ref"), args.values("file"))
    : await captureFiles(
        resolve(ctx.cwd, args.require("dir")),
        args.has("file") ? args.values("file") : ["."],
      );
  return { kind, files };
}

export async function publishArtifactCommand(
  command: "create" | "publish",
  args: ArtifactArgs,
  ctx: PublicationCommandContext,
) {
  const { client } = ctx;
  const current =
    command === "publish"
      ? await client.json<ArtifactDetail>("GET", artifactApiPath(args.id()))
      : null;
  const kind = current?.kind ?? args.require("kind");
  if (kind !== "files" && kind !== "html" && kind !== "diff")
    throw new ArtifactCommandError("--kind must be files, html, or diff");
  if (current && args.has("kind") && args.value("kind") !== current.kind)
    throw new ArtifactCommandError("An artifact's kind cannot change");
  if (args.has("version-label") && args.has("label"))
    throw new ArtifactCommandError("Use --version-label or its --label alias, not both");
  const labelFlag = args.has("version-label") ? "version-label" : "label";
  if (
    args.has("stdin-diff") &&
    ["summary", "title", labelFlag].some((name) => args.value(name) === "-")
  )
    throw new ArtifactCommandError("Patch and metadata cannot both read stdin");
  const author = ctx.actor;
  const detected = await detectPublisherRemote(ctx.cwd);
  if (detected.warning && !current && !args.has("project")) ctx.error(`${detected.warning}\n`);
  const publication: PublishArtifactBody = {
    actor: author,
    expectedSeq: args.has("expected")
      ? args.sequence("expected", true)
      : (current?.versions.at(-1)?.seq ?? 0),
    publicationKey: args.value("key") ?? randomUUID(),
    label: await ctx.text(labelFlag),
    summary: await ctx.text("summary"),
    provenance: detected.remote ? { remoteUrl: detected.remote.url } : undefined,
    content: await capture(args, kind, ctx),
  };
  if (!current && publication.expectedSeq !== 0)
    throw new ArtifactCommandError("A new artifact starts with expected sequence 0");
  // Reject invalid/empty captures before leaving an empty created artifact.
  validatePublication(publication);
  const artifact =
    current ??
    (await client.json<Artifact>("POST", "/api/artifacts", {
      kind,
      actor: author,
      title: await ctx.text("title"),
      projectId: args.value("project"),
      remoteUrl: detected.remote?.url,
      meta: {
        ...(author.role === "agent" ? { session: author.sessionId } : {}),
        ...args.metadata(),
      },
    }));
  try {
    const version = await client.json<ArtifactVersion>(
      "POST",
      `${artifactApiPath(artifact.id)}/versions`,
      publication,
    );
    return { artifact, version };
  } catch (error) {
    ctx.error(
      `Publication was not confirmed. Artifact: ${artifact.id}; retry key: ${publication.publicationKey}; expected: ${publication.expectedSeq}. Inspect its versions before retrying.\n`,
    );
    throw error;
  }
}
