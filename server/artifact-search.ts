import type { Database } from "bun:sqlite";
import MarkdownIt from "markdown-it";
import {
  type ArtifactSearchMatch,
  type ArtifactSearchOptions,
  type ArtifactSearchResponse,
  artifactSearchTerms,
  SEARCH_FILE_BYTES,
  SEARCH_QUERY_LENGTH,
  searchMatchTarget,
  searchSnippet,
} from "../shared/artifact-search.ts";
import type { Artifact, ArtifactDocumentTarget, ArtifactVersion } from "../shared/artifacts.ts";
import type { ArtifactConversations } from "./artifact-conversations.ts";
import { ArtifactError } from "./artifact-validation.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { parseUnifiedDiff } from "./git.ts";

type Location = Omit<ArtifactSearchMatch, "id" | "artifactId" | "category" | "snippet">;
type Document = {
  key: string;
  artifactId: string;
  category: ArtifactSearchMatch["category"];
  name: string;
  body: string;
  location: Location;
};
const decodeEntity = new MarkdownIt().utils.unescapeAll;

async function htmlText(source: string): Promise<string> {
  const passive = await new HTMLRewriter()
    .on("head,script,style,template,noscript,svg,canvas,[hidden],[aria-hidden=true]", {
      element(element) {
        element.remove();
      },
    })
    .on("p,div,section,article,li,h1,h2,h3,h4,h5,h6,br,tr,header,footer,main", {
      element(element) {
        element.before("\n");
        element.after("\n");
      },
    })
    .transform(new Response(source))
    .text();
  let text = "";
  await new HTMLRewriter()
    .onDocument({
      text(chunk) {
        text += chunk.text;
      },
    })
    .transform(new Response(passive))
    .text();
  return text
    .replace(/&(?:#x[\da-f]+|#\d+|[a-z][\da-z]+);/gi, decodeEntity)
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function parseArtifactSearch(params: URLSearchParams): ArtifactSearchOptions {
  const q = params.get("q")?.trim() ?? "";
  if (
    !q ||
    q.length > SEARCH_QUERY_LENGTH ||
    !artifactSearchTerms(q).length ||
    artifactSearchTerms(q).length > 16
  )
    throw new ArtifactError(
      `Search requires words or numbers, up to 16 words and ${SEARCH_QUERY_LENGTH} characters`,
    );
  const choice = <T extends string>(
    name: string,
    choices: readonly T[],
    fallback?: T,
  ): T | undefined => {
    const value = params.get(name);
    if (value === null) return fallback;
    if (!choices.includes(value as T)) throw new ArtifactError(`Invalid search ${name}`);
    return value as T;
  };
  const number = (name: string, fallback: number, min: number, max: number) => {
    const raw = params.get(name);
    if (raw === null) return fallback;
    if (
      !/^\d+$/.test(raw) ||
      !Number.isSafeInteger(Number(raw)) ||
      Number(raw) < min ||
      Number(raw) > max
    )
      throw new ArtifactError(`Search ${name} must be between ${min} and ${max}`);
    return Number(raw);
  };
  const project = params.get("project") ?? undefined;
  if (project !== undefined && (!project || project.length > 200))
    throw new ArtifactError("Invalid search project");
  return {
    q,
    project,
    state: choice("state", ["active", "archived"]),
    kind: choice("kind", ["files", "html", "diff"]),
    history: choice("history", ["latest", "all"], "latest"),
    type: choice("type", ["all", "content", "conversation"], "all"),
    attention: choice("attention", ["true", "false"], "false") === "true",
    limit: number("limit", 50, 1, 100),
    offset: number("offset", 0, 0, 100_000),
  };
}

function location(
  versionSeq: number | null,
  target: ArtifactDocumentTarget | null = null,
): Location {
  return {
    versionSeq,
    path: target?.path ?? null,
    discussionId: null,
    commentId: null,
    context:
      versionSeq === null
        ? { versionSeq: null, representation: null }
        : { versionSeq, representation: target?.kind ?? null },
    target,
  };
}

// The daemon's injected connection is the only writer. Immutable publications
// are indexed once, lazily (including old stores); mutable messages are reconciled
// after asynchronous reads, immediately before the synchronous search snapshot.
export class ArtifactSearch {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly db: Database,
    private readonly store: ArtifactStore,
    private readonly conversations: ArtifactConversations,
  ) {}

  search(options: ArtifactSearchOptions): Promise<ArtifactSearchResponse> {
    const task = this.pending.then(() => this.run(options));
    this.pending = task.catch(() => {});
    return task;
  }

  private put(doc: Document): void {
    this.db
      .query(`INSERT INTO artifact_search_documents
      (key, artifact_id, version_seq, discussion_id, comment_id, category, name, body, location_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET
        name = excluded.name, body = excluded.body, location_json = excluded.location_json
      WHERE name <> excluded.name OR body <> excluded.body OR location_json <> excluded.location_json`)
      .run(
        doc.key,
        doc.artifactId,
        doc.location.versionSeq,
        doc.location.discussionId,
        doc.location.commentId,
        doc.category,
        doc.name,
        doc.body,
        JSON.stringify(doc.location),
      );
  }

  private async index(version: ArtifactVersion): Promise<void> {
    const id = version.artifactId,
      seq = version.seq;
    if (
      this.db
        .query("SELECT 1 FROM artifact_search_versions WHERE artifact_id = ? AND version_seq = ?")
        .get(id, seq)
    )
      return;
    const docs: Document[] = [];
    let skipped = 0;
    const add = (
      suffix: string,
      name: string,
      body: string,
      target: ArtifactDocumentTarget | null,
      category: Document["category"] = "content",
    ) => {
      docs.push({
        key: JSON.stringify([id, seq, suffix]),
        artifactId: id,
        name,
        body,
        category,
        location: location(seq, target),
      });
    };
    if (version.summary || version.label)
      add("summary", version.label ?? "", version.summary ?? version.label!, null, "summary");
    if (version.kind === "diff") {
      let group = 0;
      for (const file of parseUnifiedDiff(this.store.patch(id, seq))) {
        if (file.binary) {
          skipped++;
          continue;
        }
        for (const side of ["old", "new"] as const) {
          let lines: string[] = [],
            start = 0,
            previous = 0;
          const flush = () => {
            if (!lines.length) return;
            add(`patch-${group++}`, file.path, lines.join("\n"), {
              kind: "diff",
              versionSeq: seq,
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
    } else {
      for (const file of this.store.files(id, seq)) {
        if (version.kind === "html" && file.path !== version.entrypoint) continue;
        if (file.byteLength > SEARCH_FILE_BYTES) {
          skipped++;
          continue;
        }
        const bytes = await this.store.readFile(id, seq, file.path);
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          skipped++;
          continue;
        }
        if (text.includes("\0")) {
          skipped++;
          continue;
        }
        text = text.replaceAll("\r\n", "\n");
        const target: ArtifactDocumentTarget =
          version.kind === "html"
            ? { kind: "rendered", versionSeq: seq, path: file.path, locator: null }
            : { kind: "source", versionSeq: seq, path: file.path, locator: null };
        // Historical Markdown entrypoints use their retained rendering.
        if (version.kind === "html")
          text = await htmlText(
            file.renderedHash
              ? (await this.store.readFile(id, seq, file.path, true)).toString("utf8")
              : text,
          );
        add(`file:${file.path}`, file.path, text, target);
      }
    }
    this.db
      .transaction(() => {
        // A whole-artifact deletion can commit while blob reads are in flight.
        if (
          !this.db
            .query(
              "SELECT 1 FROM artifact_versions WHERE artifact_id = ? AND seq = ? AND published_at IS NOT NULL",
            )
            .get(id, seq)
        )
          return;
        for (const doc of docs) this.put(doc);
        this.db
          .query("INSERT INTO artifact_search_versions VALUES (?, ?, ?)")
          .run(id, seq, skipped);
      })
      .immediate();
  }

  private syncMessages(artifacts: Artifact[]): void {
    const names = new Map(
      this.store.projects().map((project) => [project.id, project.name ?? project.id]),
    );
    this.db
      .transaction(() => {
        for (const artifact of artifacts) {
          this.put({
            key: artifact.id,
            artifactId: artifact.id,
            category: "artifact",
            name: [
              artifact.id,
              artifact.title,
              artifact.kind,
              artifact.state,
              names.get(artifact.projectId ?? ""),
              ...Object.values(artifact.meta),
              artifact.createdBy.sessionId,
            ].join(" "),
            body: artifact.title ?? artifact.id,
            location: location(null),
          });
          for (const discussions of this.conversations.list(artifact.id)) {
            const original = discussions.target;
            const seq = "versionSeq" in original ? original.versionSeq : null;
            const target =
              original.kind === "source" || original.kind === "rendered" || original.kind === "diff"
                ? original
                : null;
            this.put({
              key: discussions.id,
              artifactId: artifact.id,
              category: "discussions",
              name: target?.path ?? "",
              body: discussions.body,
              location: { ...location(seq, target), discussionId: discussions.id },
            });
            for (const comment of discussions.comments)
              this.put({
                key: comment.id,
                artifactId: artifact.id,
                category: "comment",
                name: "",
                body: comment.body,
                location: {
                  ...location(comment.context.versionSeq),
                  context: comment.context,
                  discussionId: discussions.id,
                  commentId: comment.id,
                },
              });
          }
        }
      })
      .immediate();
  }

  private filtered(options: ArtifactSearchOptions): Artifact[] {
    return this.store
      .list({ state: options.state, kind: options.kind, projectId: options.project })
      .filter(
        (artifact) =>
          !options.attention || (artifact.state === "active" && artifact.unhandledCount > 0),
      );
  }

  private async run(options: ArtifactSearchOptions): Promise<ArtifactSearchResponse> {
    const terms = artifactSearchTerms(options.q);
    if (!terms.length || options.q.length > SEARCH_QUERY_LENGTH)
      throw new ArtifactError("Invalid search query");
    for (;;) {
      const pending = this.filtered(options).flatMap((artifact) => {
        const versions = this.store.versions(artifact.id);
        return (options.history === "all" ? versions : versions.slice(-1)).filter(
          (version) =>
            !this.db
              .query(
                "SELECT 1 FROM artifact_search_versions WHERE artifact_id = ? AND version_seq = ?",
              )
              .get(artifact.id, version.seq),
        );
      });
      if (!pending.length) break;
      for (const version of pending) {
        try {
          await this.index(version);
        } catch (error) {
          if (!this.db.query("SELECT 1 FROM artifacts WHERE id = ?").get(version.artifactId))
            continue;
          throw error;
        }
      }
    }
    const artifacts = this.filtered(options);
    this.syncMessages(artifacts);
    const ids = JSON.stringify(artifacts.map((artifact) => artifact.id));
    const clauses = [
      "artifact_search_fts MATCH ?",
      "d.artifact_id IN (SELECT value FROM json_each(?))",
    ];
    const args = [terms.map((term) => `"${term}"*`).join(" AND "), ids];
    if (options.history !== "all")
      clauses.push(`(d.category IN ('artifact','discussions','comment') OR d.version_seq = (
      SELECT MAX(seq) FROM artifact_versions v WHERE v.artifact_id = d.artifact_id AND v.published_at IS NOT NULL))`);
    const from = `FROM artifact_search_fts JOIN artifact_search_documents d ON d.id = artifact_search_fts.rowid`;
    const counts = { all: 0, content: 0, conversation: 0 };
    for (const row of this.db
      .query<{ category: string; n: number }, string[]>(
        `SELECT d.category, COUNT(*) AS n ${from} WHERE ${clauses.join(" AND ")} GROUP BY d.category`,
      )
      .all(...args)) {
      counts.all += row.n;
      counts[
        row.category === "discussions" || row.category === "comment" ? "conversation" : "content"
      ] += row.n;
    }
    if (options.type === "conversation") clauses.push("d.category IN ('discussions','comment')");
    if (options.type === "content") clauses.push("d.category NOT IN ('discussions','comment')");
    const total = counts[options.type ?? "all"];
    const limit = options.limit ?? 50,
      offset = options.offset ?? 0;
    const rows = this.db
      .query<
        {
          key: string;
          artifact_id: string;
          category: Document["category"];
          body: string;
          location_json: string;
        },
        (string | number)[]
      >(
        `SELECT d.key, d.artifact_id, d.category, d.body, d.location_json ${from}
       WHERE ${clauses.join(" AND ")} ORDER BY bm25(artifact_search_fts, 3, 1), d.artifact_id, d.version_seq DESC, d.key LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset);
    const matches = rows.map((row) => {
      const loc: Location = JSON.parse(row.location_json);
      return {
        ...loc,
        id: row.key,
        artifactId: row.artifact_id,
        category: row.category,
        snippet: searchSnippet(row.body, terms),
        target:
          row.category === "content" ? searchMatchTarget(loc.target, row.body, terms) : loc.target,
      };
    });
    const found = new Set(matches.map((match) => match.artifactId));
    const skippedFiles = this.db
      .query<
        { n: number },
        [string]
      >(`SELECT COALESCE(SUM(skipped_files), 0) AS n FROM artifact_search_versions s
      WHERE artifact_id IN (SELECT value FROM json_each(?)) ${
        options.history === "all"
          ? ""
          : `AND version_seq = (
        SELECT MAX(seq) FROM artifact_versions v WHERE v.artifact_id = s.artifact_id AND v.published_at IS NOT NULL)`
      }`)
      .get(ids)!.n;
    return {
      matches,
      artifacts: artifacts.filter((artifact) => found.has(artifact.id)),
      counts,
      total,
      nextOffset: offset + matches.length < total ? offset + matches.length : null,
      skippedFiles,
    };
  }
}
