import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  ArtifactApiError,
  type ArtifactClient,
  artifactApiPath,
  discussionApiPath,
} from "../shared/artifact-client.ts";
import { artifactDiscussionTargetLabel, attachmentPrompt } from "../shared/artifact-prompt.ts";
import type { ArtifactSearchResponse } from "../shared/artifact-search.ts";
import type {
  Artifact,
  ArtifactActor,
  ArtifactComment,
  ArtifactDetail,
  ArtifactLifecycleResponse,
  ArtifactSource,
  ArtifactSourceRange,
  ArtifactTarget,
  ArtifactVersion,
  ArtifactWatchResult,
  Representation,
} from "../shared/artifacts.ts";
import { normalizeGitRemote } from "../shared/git-remote.ts";
import { ArtifactArgs, ArtifactCommandError } from "./artifact-args.ts";
import { fetchArtifactDiscussion } from "./artifact-discussions.ts";
import { publishArtifactCommand } from "./artifact-publish.ts";
import { runUsageCommand } from "./artifact-usage.ts";
import { downloadAttachment, readAttachmentFiles, saveAttachment } from "./attachment-files.ts";
import { currentHarnessSession, detectListener } from "./listener.ts";
export interface ArtifactCommandContext {
  registerListener?: (actor: ArtifactActor) => Promise<boolean>;
  client: ArtifactClient;
  publicUrl?: string;
  cwd: string;
  environment: Record<string, string | undefined>;
  stdin: () => Promise<string>;
  write: (text: string | Uint8Array) => void | Promise<void>;
  error: (text: string) => void;
  listen?: (
    id: string,
    actor: ArtifactActor,
    foreground: boolean,
    quiet?: boolean,
  ) => Promise<number>;
}
function representation(args: ArtifactArgs): Representation {
  const view = args.require("view");
  if (view !== "source" && view !== "rendered" && view !== "diff" && view !== "media")
    throw new ArtifactCommandError("--view must be source, rendered, diff, or media");
  return view;
}
export function commandTarget(args: ArtifactArgs): ArtifactTarget {
  if (args.has("target")) {
    try {
      return JSON.parse(args.require("target")) as ArtifactTarget;
    } catch {
      throw new ArtifactCommandError("--target must be JSON");
    }
  }
  if (!args.has("file")) {
    if (
      ["version", "view", "line", "quote", "selector", "side", "route"].some((flag) =>
        args.has(flag),
      )
    )
      throw new ArtifactCommandError("A document target needs --file, --version, and --view");
    return { kind: "artifact" };
  }
  const kind = representation(args);
  const path = args.require("file");
  const versionSeq = args.sequence();
  if (kind === "media")
    throw new ArtifactCommandError("Media targets use --target JSON and --frame snapshot.png");
  if (kind === "rendered") {
    if (args.has("line") || args.has("side"))
      throw new ArtifactCommandError("Rendered targets use selectors, not source lines");
    if (!args.has("selector") && (args.has("quote") || args.has("route")))
      throw new ArtifactCommandError("A rendered locator needs --selector");
    return {
      kind,
      path,
      versionSeq,
      locator: args.has("selector")
        ? {
            selector: args.require("selector"),
            quote: args.value("quote"),
            route: args.value("route"),
          }
        : null,
    };
  }
  if (args.has("selector") || args.has("route"))
    throw new ArtifactCommandError("Selectors and routes require a rendered target");
  if (!args.has("line")) {
    if (args.has("quote") || args.has("side"))
      throw new ArtifactCommandError("A line locator needs --line and --quote");
    return { kind, path, versionSeq, locator: null };
  }
  const match = /^(\d+)(?:-(\d+))?$/.exec(args.require("line"));
  if (!match) throw new ArtifactCommandError("--line requires a line or start-end range");
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  const locator = { start, end, quote: args.require("quote") };
  if (kind === "source") return { kind, path, versionSeq, locator };
  const side = args.value("side") ?? "new";
  if (side !== "old" && side !== "new") throw new ArtifactCommandError("--side must be old or new");
  return { kind, path, versionSeq, locator: { ...locator, side } };
}
export async function runArtifactCommand(
  command: string,
  argv: string[],
  ctx: ArtifactCommandContext,
): Promise<number> {
  if (command === "stat" || command === "gc") return runUsageCommand(command, argv, ctx);
  const args = new ArtifactArgs(argv);
  if (command === "discussions" && ["fetch", "image", "source"].includes(args.positional[0]!)) {
    command = `discussions ${args.positional.shift()}`;
  }
  if (command === "comment" && ["show", "edit"].includes(args.positional[0]!))
    command = `comment ${args.positional.shift()}`;
  const captureFlags = [
    "kind",
    "dir",
    "file",
    "ref",
    "stdin-diff",
    "working",
    "staged",
    "commit",
    "diff",
    "label",
    "version-label",
    "summary",
    "key",
    "expected",
    "no-listen",
  ];
  const targetFlags = [
    "target",
    "file",
    "version",
    "view",
    "line",
    "quote",
    "side",
    "selector",
    "route",
  ];
  const flags: Record<string, string[]> = {
    create: [...captureFlags, "title", "project", "meta"],
    publish: captureFlags,
    list: ["state", "kind", "project", "meta", "mine"],
    search: ["state", "kind", "project", "attention", "history", "type", "limit", "offset"],
    show: [],
    versions: [],
    files: ["version"],
    source: ["version", "file"],
    download: ["version", "file"],
    patch: ["version"],
    edit: ["title", "meta"],
    delete: [],
    discussions:
      args.positional[0] === "add"
        ? ["message", "attach", "frame", "key", ...targetFlags]
        : args.positional[0] === "edit"
          ? ["message", "status", "attach", "clear-attachments"]
          : [],
    "comment show": [],
    "comment edit": ["message", "attach", "clear-attachments"],
    comment: ["message", "attach", "frame", "key", ...targetFlags],
    claim: [],
    release: [],
    "discussions fetch": ["all", "discussions", "attachments-dir"],
    "discussions image": ["image", "output"],
    "discussions source": [],
    watch: ["timeout"],
    listen: ["foreground"],
    unlisten: [],
    archive: ["message", "key"],
    restore: ["key"],
    project: ["title", "remote"],
  };
  args.allow(flags[command] ?? []);
  if (args.has("attach") && args.has("clear-attachments"))
    throw new ArtifactCommandError("Use --attach or --clear-attachments, not both");
  const count = args.positional.length;
  const expected = ["create", "list"].includes(command)
    ? 0
    : command === "discussions"
      ? 2
      : command === "project"
        ? ["delete", "edit"].includes(args.positional[0])
          ? 2
          : 1
        : 1;
  if (!["claim", "release"].includes(command) && count !== expected)
    throw new ArtifactCommandError(
      `${command} expects ${expected} positional argument${expected === 1 ? "" : "s"}`,
    );
  const { client } = ctx;
  const print = (value: unknown) =>
    ctx.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
  let stdinRead = false;
  const text = async (name: string) => {
    const value = args.value(name);
    if (value !== "-") return value;
    if (stdinRead) throw new ArtifactCommandError("Only one text input can read stdin");
    stdinRead = true;
    return ctx.stdin();
  };
  const session = () => {
    const detected = detectListener(ctx.environment);
    return (
      ctx.environment.R3_AGENT_SESSION?.trim() ||
      (detected?.ok ? detected.sessionId : currentHarnessSession(ctx.environment))
    );
  };
  const actor = async (): Promise<ArtifactActor> => {
    if (args.has("human")) return { role: "human", sessionId: null };
    const id = session() ?? (command === "watch" ? `watch_${randomUUID()}` : undefined);
    if (!id)
      throw new ArtifactCommandError(
        "Set R3_AGENT_SESSION to a stable agent ID, or use --human for the human owner",
      );
    await client.json("POST", "/api/sessions", {
      id,
      ...(!ctx.environment.R3_AGENT_SESSION?.trim() && /^(claude|codex):/.test(id)
        ? { harness: id.slice(0, id.indexOf(":")) }
        : {}),
      ...(args.has("session") ? { label: args.require("session") } : {}),
    });
    return { role: "agent", sessionId: id };
  };
  const message = async () => {
    const value = await text("message");
    if (!value?.trim() && !args.has("attach"))
      throw new ArtifactCommandError("A nonempty -m message or --attach image is required");
    return value ?? "";
  };
  const detail = (id: string) => client.json<ArtifactDetail>("GET", artifactApiPath(id));
  const printPublication = async (artifact: Artifact, version: ArtifactVersion, url: string) => {
    if (args.has("json"))
      await print({
        artifact,
        version,
        url,
      });
    else
      await print(
        `${artifact.id} · ${artifact.kind} · version ${version.seq}${artifact.projectId ? `\nProject: ${artifact.projectId}` : ""}\n${url}`,
      );
  };
  switch (command) {
    case "search": {
      const params = new URLSearchParams({ q: args.id() });
      for (const flag of flags.search) if (args.has(flag)) params.set(flag, args.require(flag));
      const result = await client.json<ArtifactSearchResponse>("GET", `/api/search?${params}`);
      if (args.has("json")) await print(result);
      else {
        await print(
          `${result.total} matches (${result.counts.content} content, ${result.counts.conversation} conversations)`,
        );
        for (const match of result.matches) {
          const artifact = result.artifacts.find((item) => item.id === match.artifactId)!;
          await print(
            `${artifact.title ?? artifact.id} · ${match.category}${match.versionSeq === null ? "" : ` · v${match.versionSeq}`}${match.path ? ` · ${match.path}` : ""}\n  ${match.artifactId}${match.discussionId ? ` · ${match.discussionId}` : ""}${match.commentId ? ` · ${match.commentId}` : ""}\n  ${match.snippet}`,
          );
        }
        if (result.nextOffset !== null)
          await print(`More results: repeat with --offset ${result.nextOffset}`);
        if (result.skippedFiles)
          await print(`${result.skippedFiles} binary, invalid UTF-8, or oversized files excluded`);
      }
      return 0;
    }
    case "create":
    case "publish": {
      const author = await actor();
      let listen = !args.has("no-listen");
      let listenerWarning: string | undefined;
      if (listen && ctx.registerListener) {
        try {
          listen = await ctx.registerListener(author);
        } catch {
          listen = false;
          listenerWarning =
            "Published, but automatic listening could not be configured. Run r3 listen or use r3 watch.";
        }
      }
      const { artifact, version, url, listenerRegistered } = await publishArtifactCommand(
        command,
        args,
        {
          ...ctx,
          actor: author,
          listen,
          text,
        },
      );
      await printPublication(artifact, version, url);
      if (listen && ctx.registerListener && listenerRegistered === false)
        listenerWarning =
          "Published, but no worker listener was registered. Run r3 listen or use r3 watch.";
      if (listenerWarning) ctx.error(listenerWarning);
      return 0;
    }
    case "list": {
      const query = new URLSearchParams();
      for (const flag of ["state", "kind", "project"])
        if (args.has(flag)) query.set(flag, args.require(flag));
      for (const [key, value] of Object.entries(args.metadata())) query.set(`meta.${key}`, value);
      if (args.has("mine")) {
        const id = session();
        if (!id) throw new ArtifactCommandError("--mine requires an agent session");
        query.set("meta.session", id);
      }
      const rows = await client.json<Artifact[]>("GET", `/api/artifacts?${query}`);
      if (args.has("json")) await print(rows);
      else
        for (const row of rows)
          await print(
            `${row.id} · ${row.kind} · ${row.state}${row.watching ? " · listening" : ""} · ${row.title ?? "Untitled"}`,
          );
      return 0;
    }
    case "show": {
      const artifact = await detail(args.id());
      if (args.has("json")) await print(artifact);
      else {
        await print(
          `${artifact.id} · ${artifact.kind} · ${artifact.state}\n${artifact.title ?? "Untitled"}`,
        );
        for (const version of artifact.versions)
          await print(
            `Version ${version.seq}${version.label ? ` · ${version.label}` : ""} · ${version.publishedAt}`,
          );
        for (const discussions of artifact.discussions) {
          await print(
            `\n${discussions.id} [${discussions.status}] ${artifactDiscussionTargetLabel(discussions)}${discussions.claim ? ` · working: ${discussions.claim.sessionId}` : ""}\n[${discussions.comments[0]!.author.role}${discussions.comments[0]!.author.sessionId ? ` ${discussions.comments[0]!.author.sessionId}` : ""}] ${discussions.comments[0]!.body}\nTarget: ${JSON.stringify(discussions.target)}${discussions.comments[0]!.legacy ? `\nImported evidence: ${JSON.stringify(discussions.comments[0]!.legacy)}` : ""}`,
          );
          if (discussions.comments[0]!.attachments?.length)
            await print(attachmentPrompt(discussions.comments[0]!.attachments));
          for (const comment of discussions.comments.slice(1)) {
            if (comment.attachments?.length) await print(attachmentPrompt(comment.attachments));
            await print(
              `  ${comment.id} [${comment.author.role}${comment.author.sessionId ? ` ${comment.author.sessionId}` : ""}] ${comment.body}\n  Context: ${JSON.stringify(comment.context)}${comment.target ? `; fix: ${JSON.stringify(comment.target)}` : ""}`,
            );
          }
        }
        for (const event of artifact.events)
          await print(
            `\n${event.event} · ${event.createdAt}${event.comment?.body ? `\n${event.comment?.body}` : ""}`,
          );
      }
      return 0;
    }
    case "versions":
      await print(await client.json("GET", `${artifactApiPath(args.id())}/versions`));
      return 0;
    case "files":
      await print(
        await client.json("GET", `${artifactApiPath(args.id())}/versions/${args.sequence()}/files`),
      );
      return 0;
    case "discussions source": {
      const source = await client.json<ArtifactSourceRange>(
        "GET",
        `${discussionApiPath(args.id())}/source`,
      );
      if (args.has("json")) await print(source);
      else
        for (const [index, line] of source.text.split("\n").entries())
          await print(`${source.start + index}\t${line}`);
      return 0;
    }
    case "source": {
      const source = await client.json<ArtifactSource>(
        "GET",
        `${artifactApiPath(args.id())}/versions/${args.sequence()}/source?path=${encodeURIComponent(args.require("file"))}`,
      );
      if (args.has("json")) await print(source);
      else if (source.kind !== "text")
        await print(`${source.kind}: ${source.path} (${source.byteLength} bytes)`);
      else for (const line of source.lines) await print(`${line.lineNo}\t${line.text}`);
      return 0;
    }
    case "download":
    case "patch": {
      const path =
        command === "patch" ? "patch" : `resource?path=${encodeURIComponent(args.require("file"))}`;
      const response = await client.request(
        "GET",
        `${artifactApiPath(args.id())}/versions/${args.sequence()}/${path}`,
      );
      const reader = response.body!.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          await ctx.write(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      return 0;
    }
    case "edit": {
      await print(
        await client.json("PATCH", artifactApiPath(args.id()), {
          title: await text("title"),
          meta: args.has("meta") ? args.metadata() : undefined,
        }),
      );
      return 0;
    }
    case "delete":
      await print(await client.json("DELETE", artifactApiPath(args.id())));
      return 0;
    case "discussions": {
      const [operation, id] = args.positional;
      if (!id) throw new ArtifactCommandError("discussions add|edit|delete <id>");
      const author = await actor();
      if (operation === "add")
        await print(
          await client.json("POST", `${artifactApiPath(id)}/discussions`, {
            actor: author,
            body: await message(),
            target: commandTarget(args),
            attachments: await readAttachmentFiles(args.values("attach"), ctx.cwd),
            ...(args.has("frame")
              ? { mediaSnapshot: (await readAttachmentFiles([args.require("frame")], ctx.cwd))[0] }
              : {}),
            operationKey: args.value("key"),
          }),
        );
      else if (operation === "edit")
        await print(
          await client.json("PATCH", discussionApiPath(id), {
            actor: author,
            body: await text("message"),
            status: args.value("status"),
            ...(args.has("clear-attachments")
              ? { attachments: [] }
              : args.has("attach")
                ? { attachments: await readAttachmentFiles(args.values("attach"), ctx.cwd) }
                : {}),
          }),
        );
      else if (operation === "delete")
        await print(await client.json("DELETE", discussionApiPath(id), { actor: author }));
      else throw new ArtifactCommandError("discussions fetch|add|edit|delete <id>");
      return 0;
    }
    case "comment show": {
      const comment = await client.json<ArtifactComment>(
        "GET",
        `/api/comments/${encodeURIComponent(args.id())}`,
      );
      await print(args.has("json") ? comment : comment.body);
      return 0;
    }
    case "comment edit": {
      await print(
        await client.json("PATCH", `/api/comments/${encodeURIComponent(args.id())}`, {
          actor: await actor(),
          body: await text("message"),
          attachments: args.has("clear-attachments")
            ? []
            : args.has("attach")
              ? await readAttachmentFiles(args.values("attach"), ctx.cwd)
              : undefined,
        }),
      );
      return 0;
    }
    case "comment": {
      if ((args.has("version") || args.has("view")) && !args.has("target") && !args.has("file"))
        throw new ArtifactCommandError(
          "References inherit the discussion target; use --target or --file for a different published location",
        );
      await print(
        await client.json("POST", `${discussionApiPath(args.id())}/comments`, {
          actor: await actor(),
          body: await message(),
          attachments: await readAttachmentFiles(args.values("attach"), ctx.cwd),
          ...(args.has("frame")
            ? { mediaSnapshot: (await readAttachmentFiles([args.require("frame")], ctx.cwd))[0] }
            : {}),
          operationKey: args.value("key"),
          target: args.has("target") || args.has("file") ? commandTarget(args) : undefined,
        }),
      );
      return 0;
    }
    case "claim":
    case "release": {
      const author = await actor();
      if (author.role !== "agent")
        throw new ArtifactCommandError("Claims require an agent session");
      args.id();
      await print(
        await client.json(command === "claim" ? "POST" : "DELETE", "/api/claims", {
          sessionId: author.sessionId,
          discussionIds: args.positional,
        }),
      );
      return 0;
    }
    case "discussions image": {
      const bytes = await downloadAttachment(client, args.id(), args.require("image"));
      if (args.has("output")) await saveAttachment(resolve(ctx.cwd, args.require("output")), bytes);
      else await ctx.write(bytes);
      return 0;
    }
    case "discussions fetch": {
      await fetchArtifactDiscussion(client, args.id(), ctx.write, {
        all: args.has("all"),
        discussions: args.value("discussions"),
        attachmentsDir: args.has("attachments-dir")
          ? resolve(ctx.cwd, args.require("attachments-dir"))
          : undefined,
        cwd: ctx.cwd,
      });
      if (
        !args.has("all") &&
        !args.has("human") &&
        ctx.listen &&
        detectListener(ctx.environment).ok
      ) {
        try {
          const result = await ctx.listen(args.id(), await actor(), false, true);
          if (result !== 0) throw new Error("Listener registration failed");
        } catch {
          ctx.error(
            "Discussion fetched, but automatic listening could not be configured. Run r3 listen or use r3 watch.",
          );
        }
      }
      return 0;
    }
    case "watch": {
      const author = await actor();
      const seconds = args.has("timeout") ? Number(args.require("timeout")) : 0;
      if (!Number.isFinite(seconds) || seconds < 0)
        throw new ArtifactCommandError("--timeout must be a nonnegative number of seconds");
      const deadline = seconds ? Date.now() + seconds * 1000 : Infinity;
      const archived = async (current: ArtifactDetail) => {
        if (current.state !== "archived") return false;
        const event = current.events.findLast((event) => event.event === "archived");
        if (event?.comment?.body) await print(event.comment?.body);
        return true;
      };
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return (await archived(await detail(args.id()))) ? 0 : 2;
        let result: ArtifactWatchResult;
        try {
          result = await client.json("POST", `${artifactApiPath(args.id())}/watch`, {
            actor: author,
            timeoutMs: Math.max(1, Math.min(55000, remaining)),
          });
        } catch (error) {
          if (error instanceof ArtifactApiError && error.status === 409) return 4;
          throw error;
        }
        if (result.result === "timeout") continue;
        if (result.result === "archived") {
          if (result.event?.comment?.body) await print(result.event.comment?.body);
          return 0;
        }
        if (result.result === "discussions") {
          try {
            await fetchArtifactDiscussion(client, args.id(), ctx.write);
          } catch (error) {
            if (
              error instanceof ArtifactApiError &&
              error.status === 409 &&
              (await archived(await detail(args.id())))
            )
              return 0;
            throw error;
          }
          return 10;
        }
        return result.result === "superseded" ? 4 : 2;
      }
    }
    case "listen": {
      if (!ctx.listen)
        throw new ArtifactCommandError("This harness has no wake adapter; use r3 watch", 5);
      return ctx.listen(args.id(), await actor(), args.has("foreground"));
    }
    case "unlisten": {
      await print(
        await client.json("DELETE", `${artifactApiPath(args.id())}/listen`, {
          actor: await actor(),
        }),
      );
      return 0;
    }
    case "archive":
    case "restore": {
      try {
        const result = await client.json("POST", `${artifactApiPath(args.id())}/lifecycle`, {
          actor: await actor(),
          event: command === "archive" ? "archived" : "restored",
          operationKey: args.value("key") ?? randomUUID(),
          comment: {
            body: await text("message"),
          },
        });
        await print(result);
        return 0;
      } catch (error) {
        if (error instanceof ArtifactApiError && error.status === 502) {
          const result = error.result as ArtifactLifecycleResponse | null;
          if (result?.event?.artifactId === args.id() && result.notification?.state === "failed") {
            await print(result);
            ctx.error(
              "The lifecycle change was saved, but the listener notification failed. The operation key in the event identifies this committed change.",
            );
            return 1;
          }
        }
        throw error;
      }
    }
    case "project": {
      const operation = args.positional[0];
      const inputRemote = await text("remote");
      const remote = inputRemote === undefined ? undefined : normalizeGitRemote(inputRemote);
      if (inputRemote !== undefined && !remote)
        throw new ArtifactCommandError("Project remote must be a network Git URL");
      if (operation === "list") await print(await client.json("GET", "/api/projects"));
      else if (operation === "create")
        await print(
          await client.json("POST", "/api/projects", {
            name: await text("title"),
            remoteUrl: remote?.url,
          }),
        );
      else if (operation === "edit")
        await print(
          await client.json("PATCH", `/api/projects/${encodeURIComponent(args.id(1))}`, {
            ...(args.has("title") ? { name: await text("title") } : {}),
            ...(remote ? { remoteUrl: remote.url } : {}),
          }),
        );
      else if (operation === "delete")
        await print(await client.json("DELETE", `/api/projects/${encodeURIComponent(args.id(1))}`));
      else throw new ArtifactCommandError("project list|create|edit|delete <id>");
      return 0;
    }
    default:
      throw new ArtifactCommandError(`Unknown artifact command: ${command}`);
  }
}
