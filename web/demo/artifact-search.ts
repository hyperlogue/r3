import MarkdownIt from "markdown-it";
import {
  type ArtifactSearchMatch,
  type ArtifactSearchOptions,
  type ArtifactSearchResponse,
  artifactSearchTerms,
  SEARCH_FILE_BYTES,
  searchMatchTarget,
  searchSnippet,
  searchTextMatches,
} from "../../shared/artifact-search.ts";
import type { ArtifactDocumentTarget } from "../../shared/artifacts.ts";
import type { ArtifactDemoState } from "./artifact-model.ts";

// The static demo searches only its bundled immutable fixtures and saved
// conversations. This plain-text projection never mounts or executes HTML.
const decode = new MarkdownIt().utils.unescapeAll;
function fixtureText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|script|style|template|noscript|svg|canvas)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(?:(?:"[^"]*"|'[^']*'|[^'">])*)>/g, "\n")
    .replace(/&(?:#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, decode)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
export function searchDemoArtifacts(
  state: ArtifactDemoState,
  options: ArtifactSearchOptions,
): ArtifactSearchResponse {
  const terms = artifactSearchTerms(options.q);
  const artifacts = state.artifacts.filter(
    (a) =>
      (!options.state || a.state === options.state) &&
      (!options.kind || a.kind === options.kind) &&
      (!options.project || a.projectId === options.project) &&
      (!options.attention || (a.state === "active" && a.unhandledCount > 0)),
  );
  const matches: ArtifactSearchMatch[] = [];
  let skippedFiles = 0;
  const add = (match: Omit<ArtifactSearchMatch, "snippet">, name: string, body: string) => {
    if (searchTextMatches(`${name} ${body}`, terms))
      matches.push({
        ...match,
        snippet: searchSnippet(body, terms),
        target:
          match.category === "content"
            ? searchMatchTarget(match.target, body, terms)
            : match.target,
      });
  };
  for (const artifact of artifacts) {
    const base = {
      artifactId: artifact.id,
      path: null,
      target: null,
      threadId: null,
      commentId: null,
    };
    add(
      {
        ...base,
        id: artifact.id,
        category: "artifact",
        versionSeq: null,
        context: { versionSeq: null, representation: null },
      },
      [
        artifact.id,
        artifact.title,
        artifact.kind,
        artifact.state,
        artifact.createdBy.sessionId,
        state.projects.find((p) => p.id === artifact.projectId)?.name,
        ...Object.values(artifact.meta),
      ].join(" "),
      artifact.title ?? artifact.id,
    );
    for (const version of options.history === "all"
      ? artifact.versions
      : artifact.versions.slice(-1)) {
      const publication = state.publications[`${artifact.id}/${version.seq}`];
      if (!publication) continue;
      const versionBase = {
        ...base,
        versionSeq: version.seq,
        context: { versionSeq: version.seq, representation: null },
      };
      if (version.summary || version.label)
        add(
          { ...versionBase, id: `${artifact.id}/${version.seq}/summary`, category: "summary" },
          version.label ?? "",
          version.summary ?? version.label!,
        );
      const content = (
        suffix: string,
        path: string,
        body: string,
        target: ArtifactDocumentTarget,
      ) =>
        add(
          {
            ...versionBase,
            id: `${artifact.id}/${version.seq}/${suffix}`,
            category: "content",
            path,
            target,
            context: { versionSeq: version.seq, representation: target.kind },
          },
          path,
          body,
        );
      if (version.kind === "diff") {
        let group = 0;
        for (const file of publication.fullDiff) {
          if (file.binary) {
            skippedFiles++;
            continue;
          }
          for (const side of ["old", "new"] as const) {
            let lines: string[] = [],
              start = 0,
              previous = 0;
            const flush = () => {
              if (!lines.length) return;
              content(`patch-${group++}`, file.path, lines.join("\n"), {
                kind: "diff",
                versionSeq: version.seq,
                path: file.path,
                locator: { side, start, end: previous, quote: "" },
              });
              lines = [];
            };
            for (const row of file.lines) {
              const line = side === "old" ? (row.type === "del" ? row.oldLine : null) : row.newLine;
              if (row.type === "hunk" || line === null) {
                flush();
                continue;
              }
              if (lines.length && line !== previous + 1) flush();
              if (!lines.length) start = line;
              lines.push(row.text);
              previous = line;
            }
            flush();
          }
        }
      } else
        for (const file of publication.files) {
          if (version.kind === "html" && file.path !== version.entrypoint) continue;
          if (file.byteLength > SEARCH_FILE_BYTES) {
            skippedFiles++;
            continue;
          }
          const source = publication.sources[file.path];
          if (!source || source.kind !== "text") {
            skippedFiles++;
            continue;
          }
          const text = source.lines.map((line) => line.text).join("\n");
          content(file.path, file.path, version.kind === "html" ? fixtureText(text) : text, {
            kind: version.kind === "html" ? "rendered" : "source",
            versionSeq: version.seq,
            path: file.path,
            locator: null,
          });
        }
    }
    for (const note of artifact.threads) {
      const target = ["source", "rendered", "diff"].includes(note.target.kind)
        ? (note.target as ArtifactDocumentTarget)
        : null;
      const seq = "versionSeq" in note.target ? note.target.versionSeq : null;
      add(
        {
          ...base,
          id: note.id,
          category: "thread",
          versionSeq: seq,
          threadId: note.id,
          path: target?.path ?? null,
          target,
          context:
            seq === null
              ? { versionSeq: null, representation: null }
              : { versionSeq: seq, representation: target?.kind ?? null },
        },
        target?.path ?? "",
        note.comments[0]!.body,
      );
      for (const comment of note.comments.slice(1))
        add(
          {
            ...base,
            id: comment.id,
            category: "comment",
            versionSeq: comment.context.versionSeq,
            threadId: note.id,
            commentId: comment.id,
            context: comment.context,
          },
          "",
          comment.body,
        );
    }
  }
  matches.sort(
    (a, b) =>
      a.artifactId.localeCompare(b.artifactId) ||
      (b.versionSeq ?? 0) - (a.versionSeq ?? 0) ||
      a.id.localeCompare(b.id),
  );
  const conversation = (m: ArtifactSearchMatch) =>
    m.category === "thread" || m.category === "comment";
  const counts = {
    all: matches.length,
    conversation: matches.filter(conversation).length,
    content: matches.filter((m) => !conversation(m)).length,
  };
  const filtered = matches.filter((m) =>
    options.type === "conversation"
      ? conversation(m)
      : options.type === "content"
        ? !conversation(m)
        : true,
  );
  const offset = options.offset ?? 0,
    limit = options.limit ?? 50;
  const page = filtered.slice(offset, offset + limit);
  const found = new Set(page.map((m) => m.artifactId));
  return {
    matches: page,
    artifacts: artifacts
      .filter((a) => found.has(a.id))
      .map((a) => ({ ...a, latestVersion: a.versions.at(-1) ?? null })),
    counts,
    total: filtered.length,
    nextOffset: offset + page.length < filtered.length ? offset + page.length : null,
    skippedFiles,
  };
}
