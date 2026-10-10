import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactConversations } from "./artifact-conversations.ts";
import { ARTIFACT_SCHEMA_VERSION, createArtifactTables } from "./artifact-schema.ts";
import { ArtifactStore } from "./artifacts.ts";
import { AuthService } from "./auth.ts";
import { BlobStore } from "./blobs.ts";
import { ClientAuth } from "./client-auth.ts";
import { upgradeArtifactStore } from "./migration.ts";
import { WorkerRecords } from "./worker-records.ts";

let root: string;
let db: Database;
let blobs: BlobStore;
const time = "2026-09-01T00:00:00.000Z";
const render = async (source: string) => ({
  html: `<article>${source}</article>`,
  revision: "migration-test",
});
async function fixture(database: Database): Promise<void> {
  database.exec("PRAGMA journal_mode = WAL");
  createArtifactTables(database);
  database.exec(`PRAGMA user_version = ${ARTIFACT_SCHEMA_VERSION}`);
  database.query("INSERT INTO projects VALUES ('project_example', 'Example', NULL, ?)").run(time);
  database
    .query(`INSERT INTO artifacts
    (id, kind, project_id, title, created_by, next_seq, created_at, updated_at, legacy_json)
    VALUES ('review_retained', 'files', 'project_example', 'Retained work', 'human', 2, ?, ?, ?)`)
    .run(time, time, JSON.stringify({ source: { kind: "files" } }));
  const store = new ArtifactStore(database, blobs, render, () => time);
  await store.publish("review_retained", {
    actor: { role: "human", sessionId: null },
    expectedSeq: 0,
    publicationKey: "retained",
    content: {
      kind: "files",
      files: [
        {
          path: "index.md",
          mediaType: "text/markdown",
          base64: Buffer.from("# Kept").toString("base64"),
        },
      ],
    },
  });
  database
    .query(`INSERT INTO threads
    (id, artifact_id, artifact_kind, author, body, target_kind, legacy_anchor_json, created_at, updated_at)
    VALUES ('thread_retained', 'review_retained', 'files', 'human', 'Keep the thread', 'artifact', ?, ?, ?)`)
    .run(JSON.stringify({ source: { file: "unknown.md" } }), time, time);
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-migration-"));
  db = new Database(join(root, "store.sqlite"));
  blobs = new BlobStore(join(root, "blobs"));
  await fixture(db);
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});
function options(name = "backup.sqlite") {
  return { backupPath: join(root, name), clock: () => time };
}
function legacyNotifications() {
  db.exec(`CREATE TABLE local_agent_targets (
    session_id TEXT PRIMARY KEY REFERENCES agent_sessions(id) ON DELETE CASCADE,
    target_json TEXT NOT NULL CHECK (json_valid(target_json))
  ) STRICT;
  CREATE TABLE artifact_listeners (
    artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK (mode IN ('fallback', 'explicit')),
    id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL REFERENCES local_agent_targets(session_id) ON DELETE CASCADE,
    registered_at TEXT NOT NULL,
    PRIMARY KEY (artifact_id, mode)
  ) STRICT;
  INSERT INTO agent_sessions VALUES ('legacy-agent', 'codex', 'Legacy agent', '${time}');
  INSERT INTO local_agent_targets VALUES ('legacy-agent', '{"harness":"codex","threadId":"legacy-thread"}');
  INSERT INTO artifact_listeners VALUES ('review_retained', 'fallback', 'legacy-fallback', 'legacy-agent', '${time}');
  INSERT INTO artifact_listeners VALUES ('review_retained', 'explicit', 'legacy-explicit', 'legacy-agent', '${time}');`);
}
describe("atomic artifact schema upgrades", () => {
  test("version 15 discards legacy destinations while preserving content, access, and worker subscriptions", async () => {
    legacyNotifications();
    const auth = new AuthService(db, () => time);
    const login = auth.createLoginToken("Retained browser access");
    const session = auth.mintSession(login.info.id);
    const clients = new ClientAuth(db, () => Date.parse(time));
    const key = clients.createKey("Retained worker access");
    const subscription = {
      id: "current-subscription",
      artifactId: "review_retained",
      listenerId: "current-destination",
      actor: { role: "agent" as const, sessionId: "legacy-agent" },
      mode: "explicit" as const,
    };
    new WorkerRecords(db).save("current-worker", key.id, subscription);
    const retainedTables = [
      "artifacts",
      "artifact_versions",
      "version_files",
      "threads",
      "comments",
      "agent_sessions",
      "worker_registrations",
    ];
    const before = retainedTables.map((table) => db.query(`SELECT * FROM ${table}`).all());
    db.exec("PRAGMA user_version = 15");
    const result = await upgradeArtifactStore(db, options());
    expect(result.migrated).toBe(true);
    expect(retainedTables.map((table) => db.query(`SELECT * FROM ${table}`).all())).toEqual(before);
    expect(auth.sessionValid(session.cookieValue)).toBe(true);
    expect(clients.authenticate(key.token)?.id).toBe(key.id);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const backup = new Database(result.backupPath!, { readonly: true });
    try {
      expect(backup.query("SELECT count(*) AS n FROM artifact_listeners").get()).toEqual({ n: 2 });
    } finally {
      backup.close();
    }
    db.close();
    db = new Database(join(root, "store.sqlite"));
    expect((await upgradeArtifactStore(db, options("unused.sqlite"))).migrated).toBe(false);
    expect(
      db
        .query(
          "SELECT name FROM sqlite_master WHERE name IN ('artifact_listeners', 'local_agent_targets')",
        )
        .all(),
    ).toEqual([]);
    expect(new WorkerRecords(db).get(subscription.id)?.subscription).toEqual(subscription);
    const store = new ArtifactStore(db, blobs, render, () => time);
    expect((await store.readFile("review_retained", 2, "index.md")).toString()).toBe("# Kept");
  });
  test("version 11 retains evidence but retires subscriptions without an authorizing principal", async () => {
    db.exec("ALTER TABLE worker_registrations DROP COLUMN principal; PRAGMA user_version = 11");
    db.query("INSERT INTO worker_registrations VALUES (?, ?, ?, ?, 'disconnected')").run(
      "old-subscription",
      "worker",
      "review_retained",
      JSON.stringify({ id: "old-subscription" }),
    );
    await upgradeArtifactStore(db, options("artifact-v11.sqlite"));
    expect(db.query("SELECT state, principal FROM worker_registrations").get()).toEqual({
      state: "retired",
      principal: "",
    });
    expect(db.query("SELECT body FROM threads WHERE id='thread_retained'").get()).toEqual({
      body: "Keep the thread",
    });
  });
  test("version 5 adds threads revisions while preserving exact delivery history", async () => {
    db.exec(
      "UPDATE threads SET ever_delivered = 0; ALTER TABLE artifacts DROP COLUMN discussion_revision; PRAGMA user_version = 5",
    );
    const before = db.query("SELECT * FROM threads ORDER BY id").all();
    const result = await upgradeArtifactStore(db, options("artifact-v5.sqlite"));
    expect(result.migrated).toBe(true);
    expect(db.query("SELECT * FROM threads ORDER BY id").all()).toEqual(before);
    expect(db.query("SELECT discussion_revision FROM artifacts").all()).toEqual([
      { discussion_revision: 0 },
    ]);
  });
  for (const version of [3, 4]) {
    test(`version ${version} preserves possible delivery history without inventing a delivery timestamp`, async () => {
      db.exec(
        `ALTER TABLE threads DROP COLUMN ever_delivered; ALTER TABLE artifacts DROP COLUMN discussion_revision; PRAGMA user_version = ${version}`,
      );
      const store = new ArtifactStore(db, blobs, render, () => time);
      const human = { role: "human" as const, sessionId: null };
      const before = db
        .query("SELECT sent_at, status_unsent FROM threads WHERE id = 'thread_retained'")
        .get();
      const result = await upgradeArtifactStore(db, options("artifact-v4.sqlite"));
      expect(result.migrated).toBe(true);
      expect(
        db.query("SELECT sent_at, status_unsent FROM threads WHERE id = 'thread_retained'").get(),
      ).toEqual(before);
      const conversations = new ArtifactConversations(db, store, () => time);
      conversations.edit("thread_retained", { actor: human, body: "Changed after upgrade" });
      conversations.edit("thread_retained", { actor: human, status: "resolved" });
      expect(conversations.get("thread_retained").comments[0]!.sentAt).toBeNull();
      expect(conversations.unsent("review_retained").map((note) => note.id)).toEqual([
        "thread_retained",
      ]);
      const fresh = await conversations.add("review_retained", {
        actor: human,
        body: "New after upgrade",
        target: { kind: "artifact" },
      });
      conversations.edit(fresh.id, { actor: human, status: "resolved" });
      expect(conversations.get(fresh.id).statusUnsent).toBe(false);
      expect((await upgradeArtifactStore(db, options("unused-v5.sqlite"))).migrated).toBe(false);
      expect(conversations.get(fresh.id).statusUnsent).toBe(false);
      const backup = new Database(result.backupPath!, { readonly: true });
      try {
        expect(backup.query("PRAGMA user_version").get()).toEqual({ user_version: version });
        expect(
          backup
            .query("PRAGMA table_info(threads)")
            .all()
            .some((column: any) => column.name === "ever_delivered"),
        ).toBe(false);
      } finally {
        backup.close();
      }
    });
  }
  test("version 2 gains remote identities without changing project or artifact membership", async () => {
    const before = db.query("SELECT id, project_id FROM artifacts ORDER BY id").all();
    const projects = db.query("SELECT * FROM projects ORDER BY id").all();
    db.exec(
      "DROP TABLE project_remotes; ALTER TABLE threads DROP COLUMN ever_delivered; ALTER TABLE artifacts DROP COLUMN discussion_revision; PRAGMA user_version = 2",
    );
    const result = await upgradeArtifactStore(db, options("artifact-v2.sqlite"));
    expect(result.migrated).toBe(true);
    expect(db.query("SELECT * FROM project_remotes").all()).toEqual([]);
    expect(db.query("SELECT id, project_id FROM artifacts ORDER BY id").all()).toEqual(before);
    expect(db.query("SELECT * FROM projects ORDER BY id").all()).toEqual(projects);
    expect(db.query("PRAGMA user_version").get()).toEqual({
      user_version: ARTIFACT_SCHEMA_VERSION,
    });
  });
  test("upgrades artifact overviews into retained evidence with a private backup", async () => {
    db.exec(
      "ALTER TABLE artifacts ADD COLUMN summary TEXT; ALTER TABLE threads DROP COLUMN ever_delivered; ALTER TABLE artifacts DROP COLUMN discussion_revision; PRAGMA user_version = 1",
    );
    db.query("UPDATE artifacts SET summary = ? WHERE id = ?").run(
      "Retained overview",
      "review_retained",
    );
    const backupPath = join(root, "artifact-v1.sqlite");
    const result = await upgradeArtifactStore(db, { ...options(), backupPath });
    expect(result.migrated).toBe(true);
    const store = new ArtifactStore(db, blobs, render, () => time);
    expect(store.get("review_retained")).not.toHaveProperty("summary");
    expect(store.get("review_retained").legacy?.retiredOverview).toBe("Retained overview");
    expect((await store.readFile("review_retained", 2, "index.md")).toString()).toBe("# Kept");
    expect(
      db
        .query("PRAGMA table_info(artifacts)")
        .all()
        .some((column: any) => column.name === "summary"),
    ).toBe(false);
    const backup = new Database(backupPath, { readonly: true });
    expect(
      backup.query("SELECT summary FROM artifacts WHERE id = 'review_retained'").get(),
    ).toEqual({ summary: "Retained overview" });
    backup.close();
    expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect((await upgradeArtifactStore(db, options("unused.sqlite"))).migrated).toBe(false);
  });
});
test("version 7 gains an empty derived search index without changing publications or threads", async () => {
  const before = db.query("SELECT * FROM artifact_versions").all();
  const threads = db.query("SELECT * FROM threads").all();
  db.exec(`DROP TRIGGER search_document_insert; DROP TRIGGER search_document_delete; DROP TRIGGER search_document_update;
    DROP TABLE artifact_search_fts; DROP TABLE artifact_search_documents; DROP TABLE artifact_search_versions; PRAGMA user_version = 7;`);
  const result = await upgradeArtifactStore(db, options("search-backup.sqlite"));
  expect(result.migrated).toBe(true);
  expect(db.query("SELECT * FROM artifact_versions").all()).toEqual(before);
  expect(db.query("SELECT * FROM threads").all()).toEqual(threads);
  expect(db.query("SELECT * FROM artifact_search_documents").all()).toEqual([]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  const backup = new Database(result.backupPath!, { readonly: true });
  try {
    expect(backup.query("PRAGMA user_version").get()).toEqual({ user_version: 7 });
  } finally {
    backup.close();
  }
});
test("upgrades preserve imported evidence and login state across reopen", async () => {
  const auth = new AuthService(db, () => time);
  const token = auth.createLoginToken("Upgrade test");
  const session = auth.mintSession(token.info.id);
  db.exec("PRAGMA user_version = 8");
  await upgradeArtifactStore(db, options());
  db.close();
  db = new Database(join(root, "store.sqlite"));
  const store = new ArtifactStore(db, blobs, render, () => time);
  const conversations = new ArtifactConversations(db, store, () => time);
  expect(store.get("review_retained").legacy).toEqual({ source: { kind: "files" } });
  expect(conversations.get("thread_retained").comments[0]!.legacy).toEqual({
    source: { file: "unknown.md" },
  });
  expect((await store.readFile("review_retained", 2, "index.md")).toString()).toBe("# Kept");
  expect(new AuthService(db, () => time).sessionValid(session.cookieValue)).toBe(true);
  expect(new AuthService(db, () => time).verifyLogin(token.token)).toEqual({
    tokenId: token.info.id,
  });
});
test("failed upgrades roll back schema changes and preserve the private backup", async () => {
  legacyNotifications();
  db.exec("ALTER TABLE artifacts ADD COLUMN summary TEXT; PRAGMA user_version = 1");
  // An inconsistent old schema forces a failure after the overview column is removed.
  await expect(upgradeArtifactStore(db, options())).rejects.toThrow();
  expect(db.inTransaction).toBe(false);
  expect(db.query("SELECT summary FROM artifacts").all()).toEqual([{ summary: null }]);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
  expect(db.query("SELECT count(*) AS n FROM artifact_listeners").get()).toEqual({ n: 2 });
  expect(db.query("SELECT count(*) AS n FROM local_agent_targets").get()).toEqual({ n: 1 });
  expect((await stat(options().backupPath)).mode & 0o777).toBe(0o600);
  db.exec(
    "ALTER TABLE threads DROP COLUMN ever_delivered; ALTER TABLE artifacts DROP COLUMN discussion_revision",
  );
  await expect(upgradeArtifactStore(db, options())).rejects.toThrow();
  expect((await upgradeArtifactStore(db, options("retry.sqlite"))).migrated).toBe(true);
});
test("unrecognized and newer schemas are rejected before creating a backup", async () => {
  db.exec("PRAGMA user_version = 0");
  await expect(upgradeArtifactStore(db, options())).rejects.toThrow("Unrecognized store schema");
  db.exec(`PRAGMA user_version = ${ARTIFACT_SCHEMA_VERSION + 1}`);
  await expect(upgradeArtifactStore(db, options())).rejects.toThrow("newer r3 binary");
  expect(await Bun.file(options().backupPath).exists()).toBe(false);
});
