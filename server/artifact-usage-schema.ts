import type { Database } from "bun:sqlite";

// Counts have no artifact/session identifiers or foreign keys: deletion cannot
// erase past activity. UTC instants allow rebucketing after a server TZ change.
export function installArtifactUsage(db: Database, completeSince: string | null): void {
  db.exec(`CREATE TABLE IF NOT EXISTS artifact_activity (
    occurred_at TEXT NOT NULL,
    metric TEXT NOT NULL CHECK (metric IN ('artifactsCreated','versionsPublished','threadsAdded','commentsAdded','archived','restored')),
    count INTEGER NOT NULL CHECK (count > 0),
    PRIMARY KEY (occurred_at, metric)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS artifact_activity_coverage (
    id INTEGER PRIMARY KEY CHECK (id = 1), complete_since TEXT
  ) STRICT;`);
  if (!db.query("SELECT 1 FROM artifact_activity_coverage").get()) {
    db.query("INSERT INTO artifact_activity_coverage VALUES (1, ?)").run(completeSince);
    db.exec(`INSERT INTO artifact_activity SELECT occurred_at, metric, count(*) FROM (
      SELECT created_at AS occurred_at, 'artifactsCreated' AS metric FROM artifacts
      UNION ALL SELECT published_at, 'versionsPublished' FROM artifact_versions WHERE published_at IS NOT NULL
      UNION ALL SELECT created_at, 'threadsAdded' FROM discussions
      UNION ALL SELECT created_at, 'commentsAdded' FROM comments
      UNION ALL SELECT created_at, event FROM artifact_events
    ) GROUP BY occurred_at, metric;`);
  }
  const insert = (
    time: string,
    metric: string,
  ) => `INSERT INTO artifact_activity VALUES (${time}, ${metric}, 1)
    ON CONFLICT(occurred_at, metric) DO UPDATE SET count = count + 1;`;
  for (const [name, table, time, metric, condition] of [
    ["artifact", "artifacts", "NEW.created_at", "'artifactsCreated'", ""],
    [
      "publication",
      "artifact_versions",
      "NEW.published_at",
      "'versionsPublished'",
      "WHEN NEW.published_at IS NOT NULL",
    ],
    ["thread", "discussions", "NEW.created_at", "'threadsAdded'", ""],
    ["comment", "comments", "NEW.created_at", "'commentsAdded'", ""],
    ["lifecycle", "artifact_events", "NEW.created_at", "NEW.event", ""],
  ])
    db.exec(
      `CREATE TRIGGER IF NOT EXISTS activity_${name} AFTER INSERT ON ${table} ${condition} BEGIN ${insert(time, metric)} END;`,
    );
  db.exec(`CREATE TRIGGER IF NOT EXISTS activity_publication_commit AFTER UPDATE OF published_at ON artifact_versions
    WHEN OLD.published_at IS NULL AND NEW.published_at IS NOT NULL
    BEGIN ${insert("NEW.published_at", "'versionsPublished'")} END;`);
}
