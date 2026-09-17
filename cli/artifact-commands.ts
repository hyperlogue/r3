import { randomUUID } from "node:crypto";
import {
  ArtifactApiError,
  type ArtifactClient,
  artifactApiPath,
  feedbackApiPath,
} from "../shared/artifact-client.ts";
import { artifactFeedbackTargetLabel } from "../shared/artifact-prompt.ts";
import type {
  Artifact,
  ArtifactActor,
  ArtifactDetail,
  ArtifactLifecycleResponse,
  ArtifactMessageContext,
  ArtifactSource,
  ArtifactTarget,
  ArtifactVersion,
  ArtifactWatchResult,
  Representation,
} from "../shared/artifacts.ts";
import { normalizeGitRemote } from "../shared/git-remote.ts";
import { ArtifactArgs, ArtifactCommandError } from "./artifact-args.ts";
import { publishArtifactCommand } from "./artifact-publish.ts";
import { currentHarnessSession, detectListener } from "./listener.ts";

export interface ArtifactCommandContext {
  client: ArtifactClient;
  publicUrl?: string;
  cwd: string;
  environment: Record<string, string | undefined>;
  stdin: () => Promise<string>;
  write: (text: string | Uint8Array) => void;
  error: (text: string) => void;
  listen?: (id: string, actor: ArtifactActor, foreground: boolean) => Promise<number>;
}

function representation(args: ArtifactArgs): Representation {
  const view = args.require("view");
  if (view !== "source" && view !== "rendered" && view !== "diff")
    throw new ArtifactCommandError("--view must be source, rendered, or diff");
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
  const args = new ArtifactArgs(argv);
  if (command === "feedback" && args.positional[0] === "fetch") {
    args.positional.shift();
    command = "feedback fetch";
  } else if (command === "prompt") command = "feedback fetch";
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
    show: [],
    versions: [],
    files: ["version"],
    source: ["version", "file"],
    download: ["version", "file"],
    patch: ["version"],
    edit: ["title", "meta"],
    delete: [],
    feedback: args.positional[0] === "add" ? ["message", ...targetFlags] : ["message", "status"],
    reply: ["message", "version", "view", "target"],
    place: [...targetFlags, "state"],
    claim: [],
    release: [],
    "feedback fetch": ["all", "feedback"],
    watch: ["timeout"],
    listen: ["foreground"],
    archive: ["message", "key"],
    restore: ["key"],
    project: ["title", "remote"],
  };
  args.allow(flags[command] ?? []);
  const count = args.positional.length;
  const expected = ["create", "list"].includes(command)
    ? 0
    : command === "feedback"
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
    const detected = command === "listen" ? detectListener(ctx.environment) : null;
    return (
      args.value("session")?.trim() ||
      ctx.environment.R3_AGENT_SESSION?.trim() ||
      (detected?.ok ? detected.sessionId : currentHarnessSession(ctx.environment))
    );
  };
  const actor = async (): Promise<ArtifactActor> => {
    if (args.has("human")) return { role: "human", sessionId: null };
    const id = session();
    if (!id)
      throw new ArtifactCommandError(
        "Set --session or R3_AGENT_SESSION to a stable agent ID, or use --human for the human owner",
      );
    await client.json("POST", "/api/sessions", { id });
    return { role: "agent", sessionId: id };
  };
  const message = async () => {
    const value = await text("message");
    if (!value?.trim()) throw new ArtifactCommandError("A nonempty -m message is required");
    return value;
  };
  const detail = (id: string) => client.json<ArtifactDetail>("GET", artifactApiPath(id));
  const printPublication = (artifact: Artifact, version: ArtifactVersion) => {
    if (args.has("json"))
      print({
        artifact,
        version,
        url: `${ctx.publicUrl ?? client.url}/${encodeURIComponent(artifact.id)}`,
      });
    else
      print(
        `${artifact.id} · ${artifact.kind} · version ${version.seq}${artifact.projectId ? `\nProject: ${artifact.projectId}` : ""}\n${ctx.publicUrl ?? client.url}/${encodeURIComponent(artifact.id)}`,
      );
  };
  switch (command) {
    case "create":
    case "publish": {
      const { artifact, version } = await publishArtifactCommand(command, args, {
        ...ctx,
        actor: await actor(),
        text,
      });
      printPublication(artifact, version);
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
      if (args.has("json")) print(rows);
      else
        for (const row of rows)
          print(
            `${row.id} · ${row.kind} · ${row.state}${row.watching ? " · listening" : ""} · ${row.title ?? "Untitled"}`,
          );
      return 0;
    }
    case "show": {
      const artifact = await detail(args.id());
      if (args.has("json")) print(artifact);
      else {
        print(
          `${artifact.id} · ${artifact.kind} · ${artifact.state}\n${artifact.title ?? "Untitled"}`,
        );
        for (const version of artifact.versions)
          print(
            `Version ${version.seq}${version.label ? ` · ${version.label}` : ""} · ${version.publishedAt}`,
          );
        for (const feedback of artifact.feedback) {
          print(
            `\n${feedback.id} [${feedback.status}] ${artifactFeedbackTargetLabel(feedback)}${feedback.claim ? ` · working: ${feedback.claim.sessionId}` : ""}\n[${feedback.author.role}${feedback.author.sessionId ? ` ${feedback.author.sessionId}` : ""}] ${feedback.body}\nTarget: ${JSON.stringify(feedback.target)}${feedback.legacy ? `\nImported evidence: ${JSON.stringify(feedback.legacy)}` : ""}`,
          );
          for (const reply of feedback.replies)
            print(
              `  ${reply.id} [${reply.author.role}${reply.author.sessionId ? ` ${reply.author.sessionId}` : ""}] ${reply.body}\n  Context: ${JSON.stringify(reply.context)}${reply.target ? `; fix: ${JSON.stringify(reply.target)}` : ""}`,
            );
        }
        for (const event of artifact.events)
          print(
            `\n${event.event} · ${event.createdAt}${event.message ? `\n${event.message}` : ""}`,
          );
      }
      return 0;
    }
    case "versions":
      print(await client.json("GET", `${artifactApiPath(args.id())}/versions`));
      return 0;
    case "files":
      print(
        await client.json("GET", `${artifactApiPath(args.id())}/versions/${args.sequence()}/files`),
      );
      return 0;
    case "source": {
      const source = await client.json<ArtifactSource>(
        "GET",
        `${artifactApiPath(args.id())}/versions/${args.sequence()}/source?path=${encodeURIComponent(args.require("file"))}`,
      );
      if (args.has("json")) print(source);
      else if (source.kind !== "text")
        print(`${source.kind}: ${source.path} (${source.byteLength} bytes)`);
      else for (const line of source.lines) print(`${line.lineNo}\t${line.text}`);
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
          ctx.write(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      return 0;
    }
    case "edit": {
      print(
        await client.json("PATCH", artifactApiPath(args.id()), {
          title: await text("title"),
          meta: args.has("meta") ? args.metadata() : undefined,
        }),
      );
      return 0;
    }
    case "delete":
      print(await client.json("DELETE", artifactApiPath(args.id())));
      return 0;
    case "feedback": {
      const [operation, id] = args.positional;
      if (!id) throw new ArtifactCommandError("feedback add|edit|delete <id>");
      const author = await actor();
      if (operation === "add")
        print(
          await client.json("POST", `${artifactApiPath(id)}/feedback`, {
            actor: author,
            body: await message(),
            target: commandTarget(args),
          }),
        );
      else if (operation === "edit")
        print(
          await client.json("PATCH", feedbackApiPath(id), {
            actor: author,
            body: await text("message"),
            status: args.value("status"),
          }),
        );
      else if (operation === "delete")
        print(await client.json("DELETE", feedbackApiPath(id), { actor: author }));
      else throw new ArtifactCommandError("feedback fetch|add|edit|delete <id>");
      return 0;
    }
    case "reply": {
      if (args.has("view") && !args.has("version"))
        throw new ArtifactCommandError("--view requires --version");
      const context: ArtifactMessageContext = args.has("version")
        ? {
            versionSeq: args.sequence(),
            representation: args.has("view") ? representation(args) : null,
          }
        : { versionSeq: null, representation: null };
      print(
        await client.json("POST", `${feedbackApiPath(args.id())}/replies`, {
          actor: await actor(),
          body: await message(),
          context,
          target: args.has("target") ? commandTarget(args) : undefined,
        }),
      );
      return 0;
    }
    case "place": {
      if (!args.has("target") && !args.has("file"))
        throw new ArtifactCommandError("A placement requires a document target");
      print(
        await client.json("PUT", `${feedbackApiPath(args.id())}/placements`, {
          actor: await actor(),
          target: commandTarget(args),
          state: args.require("state"),
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
      print(
        await client.json(command === "claim" ? "POST" : "DELETE", "/api/claims", {
          sessionId: author.sessionId,
          feedbackIds: args.positional,
        }),
      );
      return 0;
    }
    case "feedback fetch": {
      const path = `${artifactApiPath(args.id())}/prompt`;
      const selected = args.value("feedback");
      const response = args.has("all")
        ? await client.request(
            "GET",
            `${path}${selected ? `?feedback=${encodeURIComponent(selected)}` : ""}`,
          )
        : await client.request("POST", path, { feedback: selected?.split(",") });
      ctx.write(await response.text());
      return 0;
    }
    case "watch": {
      const author = await actor();
      const seconds = args.has("timeout") ? Number(args.require("timeout")) : 0;
      if (!Number.isFinite(seconds) || seconds < 0)
        throw new ArtifactCommandError("--timeout must be a nonnegative number of seconds");
      const deadline = seconds ? Date.now() + seconds * 1000 : Infinity;
      const archived = (current: ArtifactDetail) => {
        if (current.state !== "archived") return false;
        const event = current.events.findLast((event) => event.event === "archived");
        if (event?.message) print(event.message);
        return true;
      };
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return archived(await detail(args.id())) ? 0 : 2;
        let result: ArtifactWatchResult;
        try {
          result = await client.json("POST", `${artifactApiPath(args.id())}/watch`, {
            actor: author,
            timeoutMs: Math.max(1, Math.min(55_000, remaining)),
          });
        } catch (error) {
          if (error instanceof ArtifactApiError && error.status === 409) return 4;
          throw error;
        }
        if (result.result === "timeout") continue;
        if (result.result === "archived") {
          if (result.event?.message) print(result.event.message);
          return 0;
        }
        if (result.result === "feedback") {
          try {
            ctx.write(
              await (
                await client.request("POST", `${artifactApiPath(args.id())}/prompt`, {})
              ).text(),
            );
          } catch (error) {
            if (
              error instanceof ArtifactApiError &&
              error.status === 409 &&
              archived(await detail(args.id()))
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
    case "archive":
    case "restore": {
      try {
        const result = await client.json("POST", `${artifactApiPath(args.id())}/lifecycle`, {
          actor: await actor(),
          event: command === "archive" ? "archived" : "restored",
          operationKey: args.value("key") ?? randomUUID(),
          message: await text("message"),
        });
        print(result);
        return 0;
      } catch (error) {
        if (error instanceof ArtifactApiError && error.status === 502) {
          const result = error.result as ArtifactLifecycleResponse | null;
          if (result?.event?.artifactId === args.id() && result.notification?.state === "failed") {
            print(result);
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
      if (operation === "list") print(await client.json("GET", "/api/projects"));
      else if (operation === "create")
        print(
          await client.json("POST", "/api/projects", {
            name: await text("title"),
            remoteUrl: remote?.url,
          }),
        );
      else if (operation === "edit")
        print(
          await client.json("PATCH", `/api/projects/${encodeURIComponent(args.id(1))}`, {
            ...(args.has("title") ? { name: await text("title") } : {}),
            ...(remote ? { remoteUrl: remote.url } : {}),
          }),
        );
      else if (operation === "delete")
        print(await client.json("DELETE", `/api/projects/${encodeURIComponent(args.id(1))}`));
      else throw new ArtifactCommandError("project list|create|edit|delete <id>");
      return 0;
    }
    default:
      throw new ArtifactCommandError(`Unknown artifact command: ${command}`);
  }
}
