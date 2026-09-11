import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createArtifactTables } from "./artifact-schema.ts";

const time = "2026-01-01T00:00:00.000Z";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
let db: Database;

function run(sql: string, ...values: (string | number | null)[]) {
  return db.query(sql).run(...values);
}

function artifact(id: string, kind = "files") {
  run(
    "INSERT INTO artifacts(id,kind,created_by,created_at,updated_at) VALUES (?,?,'human',?,?)",
    id,
    kind,
    time,
    time,
  );
}

function version(
  id: string,
  kind = "files",
  count: number | null = 1,
  entry: string | null = null,
) {
  const { seq } = db
    .query("UPDATE artifacts SET next_seq=next_seq+1 WHERE id=? RETURNING next_seq-1 AS seq")
    .get(id) as { seq: number };
  run(
    `INSERT INTO artifact_versions(artifact_id,seq,kind,publication_key,content_hash,
      published_by,file_count,entrypoint,patch_body,created_at)
     VALUES (?,?,?,?,?,'human',?,?,?,?)`,
    id,
    seq,
    kind,
    `publication-${seq}`,
    hash(`${id}:${seq}`),
    count,
    entry,
    kind === "diff" ? "--- a/example.ts\n+++ b/example.ts\n@@ -1 +1 @@\n-old\n+new\n" : null,
    time,
  );
  return seq;
}

function file(id: string, seq: number, path = "notes.md", body = "# Notes", kind = "files") {
  run("INSERT OR IGNORE INTO blobs VALUES (?,?,?)", hash(body), Buffer.byteLength(body), time);
  run(
    `INSERT INTO version_files(artifact_id,version_seq,artifact_kind,path,media_type,blob_hash)
     VALUES (?,?,?,?,'text/plain',?)`,
    id,
    seq,
    kind,
    path,
    hash(body),
  );
}

function finalize(id: string, seq: number) {
  run("UPDATE artifact_versions SET published_at=? WHERE artifact_id=? AND seq=?", time, id, seq);
}

function feedback(id: string, owner: string, seq = 1) {
  run(
    `INSERT INTO feedback(id,artifact_id,artifact_kind,author,body,target_kind,
      target_version_seq,target_path,created_at,updated_at)
     VALUES (?,?,'files','human','Please revise this','rendered',?,'notes.md',?,?)`,
    id,
    owner,
    seq,
    time,
    time,
  );
}

beforeEach(() => {
  db = new Database(":memory:");
  createArtifactTables(db);
  run("INSERT INTO agent_sessions(id,label,created_at) VALUES ('agent-one','First agent',?)", time);
  artifact("files");
  artifact("html", "html");
  artifact("diff", "diff");
});

afterEach(() => db.close());

describe("artifact schema", () => {
  test("directory publications require members, while a member may have zero bytes", () => {
    expect(() => version("files", "files", 0)).toThrow();
    const seq = version("files");
    expect(() => finalize("files", seq)).toThrow("incomplete");
    file("files", seq, "empty.txt", "");
    finalize("files", seq);
    expect(db.query("SELECT byte_length FROM blobs").get()).toEqual({ byte_length: 0 });
  });

  test("HTML entrypoints belong to the same version, and diff carries only a patch", () => {
    expect(() => version("html", "html", 1)).toThrow();
    db.transaction(() => {
      const seq = version("html", "html", 1, "index.html");
      expect(() => finalize("html", seq)).toThrow();
      file("html", seq, "index.html", "<h1>Example</h1>", "html");
      finalize("html", seq);
    })();
    const diff = version("diff", "diff", null);
    expect(() => file("diff", diff)).toThrow();
    finalize("diff", diff);
    expect(() => version("files", "html", 1, "index.html")).toThrow();
  });

  test("publication is finalized once and content survives until whole-artifact deletion", () => {
    const seq = version("files");
    file("files", seq);
    finalize("files", seq);
    expect(() => finalize("files", seq)).toThrow();
    expect(() => file("files", seq, "later.txt")).toThrow();
    expect(() => run("UPDATE version_files SET media_type='text/html'")).toThrow();
    expect(() => run("UPDATE artifact_versions SET summary='changed'")).toThrow();
    expect(() => run("DELETE FROM version_files")).toThrow();
    expect(() => run("DELETE FROM artifact_versions")).toThrow();
    expect(() => run("DELETE FROM blobs")).toThrow();
    run("DELETE FROM artifacts WHERE id='files'");
    expect(db.query("SELECT count(*) AS n FROM version_files").get()).toEqual({ n: 0 });
    expect(db.query("SELECT count(*) AS n FROM blobs").get()).toEqual({ n: 1 });
  });

  test("failed publication rolls back allocation, and archive blocks finalization", () => {
    expect(() =>
      db.transaction(() => {
        version("files");
        throw new Error("upload failed");
      })(),
    ).toThrow("upload failed");
    expect(db.query("SELECT next_seq FROM artifacts WHERE id='files'").get()).toEqual({
      next_seq: 1,
    });
    const seq = version("files");
    file("files", seq);
    run("UPDATE artifacts SET state='archived',archived_at=? WHERE id='files'", time);
    expect(() => finalize("files", seq)).toThrow("archived");
    expect(() => run("UPDATE artifacts SET next_seq=1 WHERE id='files'")).toThrow();
    expect(() => version("files")).toThrow();
  });

  test("all agent attribution requires a session and all human attribution forbids one", () => {
    expect(() =>
      run(
        "INSERT INTO artifacts(id,kind,created_at,updated_at) VALUES ('missing-role','files',?,?)",
        time,
        time,
      ),
    ).toThrow();
    expect(() =>
      run(
        "INSERT INTO artifacts(id,kind,created_by,created_at,updated_at) VALUES ('missing-session','files','agent',?,?)",
        time,
        time,
      ),
    ).toThrow();
    expect(() =>
      run(
        `INSERT INTO artifacts(id,kind,created_by,creator_session_id,created_at,updated_at)
         VALUES ('human-session','files','human','agent-one',?,?)`,
        time,
        time,
      ),
    ).toThrow();
    run(
      `INSERT INTO feedback(id,artifact_id,artifact_kind,author,body,target_kind,created_at,updated_at)
       VALUES ('human-note','files','files','human','message','artifact',?,?)`,
      time,
      time,
    );
    expect(() =>
      run(
        `INSERT INTO feedback(id,artifact_id,artifact_kind,author,body,target_kind,created_at,updated_at)
         VALUES ('missing-session','files','files','agent','message','artifact',?,?)`,
        time,
        time,
      ),
    ).toThrow();
    expect(() =>
      run(
        `INSERT INTO replies(id,feedback_id,artifact_id,artifact_kind,author,body,created_at)
         VALUES ('missing-session','human-note','files','files','agent','message',?)`,
        time,
      ),
    ).toThrow();
    run(
      `INSERT INTO artifacts(id,kind,created_by,creator_session_id,created_at,updated_at)
       VALUES ('agent-artifact','files','agent','agent-one',?,?)`,
      time,
      time,
    );
    expect(() => run("DELETE FROM agent_sessions")).toThrow();
  });

  test("message context, native target, and placement retain separate version identities", () => {
    for (let i = 0; i < 2; i++) {
      const seq = version("files");
      file("files", seq);
      finalize("files", seq);
    }
    feedback("note", "files");
    run(
      `INSERT INTO replies(id,feedback_id,artifact_id,artifact_kind,author,agent_session_id,
        body,context_version_seq,context_representation,target_kind,target_version_seq,
        target_path,created_at)
       VALUES ('reply','note','files','files','agent','agent-one','Updated',1,'rendered',
        'source',2,'notes.md',?)`,
      time,
    );
    for (const representation of ["source", "rendered"]) {
      run(
        `INSERT INTO feedback_placements(feedback_id,artifact_id,artifact_kind,version_seq,
          document_path,representation,match_state,created_at,updated_at)
         VALUES ('note','files','files',2,'notes.md',?,'unplaced',?,?)`,
        representation,
        time,
        time,
      );
    }
    expect(db.query("SELECT count(*) AS n FROM feedback_placements").get()).toEqual({ n: 2 });
    expect(() => run("UPDATE feedback SET target_version_seq=2")).toThrow();
    expect(() => run("UPDATE replies SET context_version_seq=2")).toThrow();
    expect(() => feedback("other", "html")).toThrow();
    db.transaction(() => run("DELETE FROM artifacts WHERE id='files'"))();
    expect(db.query("SELECT count(*) AS n FROM replies").get()).toEqual({ n: 0 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("archive events preserve optional messages, ordering, and retry identity", () => {
    const event = (id: string, kind: string, message: string | null, key = id) =>
      run(
        `INSERT INTO artifact_events(id,artifact_id,event,operation_key,actor,message,created_at)
         VALUES (?,'files',?,?,'human',?,?)`,
        id,
        kind,
        key,
        message,
        time,
      );
    event("first", "archived", "Continue later");
    event("restored", "restored", null);
    event("second", "archived", null);
    expect(() => event("retry", "archived", "Continue later", "first")).toThrow();
    expect(() => event("bad-restore", "restored", "message")).toThrow();
    expect(() => event("blank", "archived", " ")).toThrow();
    expect(() => run("UPDATE artifact_events SET message='replaced'")).toThrow();
    expect(() => run("DELETE FROM artifact_events")).toThrow();
    expect(db.query("SELECT id FROM artifact_events ORDER BY seq").all()).toEqual([
      { id: "first" },
      { id: "restored" },
      { id: "second" },
    ]);
    run("DELETE FROM artifacts WHERE id='files'");
    expect(db.query("SELECT count(*) AS n FROM artifact_events").get()).toEqual({ n: 0 });
  });

  test("whole HTML deletion resolves the cyclic entrypoint reference", () => {
    db.transaction(() => {
      const seq = version("html", "html", 1, "index.md");
      file("html", seq, "index.md", "# Hello", "html");
      finalize("html", seq);
    })();
    db.transaction(() => run("DELETE FROM artifacts WHERE id='html'"))();
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  });
});
