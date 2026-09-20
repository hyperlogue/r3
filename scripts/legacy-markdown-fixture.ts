import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { renderArtifactDocument } from "../server/artifact-document.ts";
import { ARTIFACT_SCHEMA_VERSION, createArtifactTables } from "../server/artifact-schema.ts";
import { canonicalJson } from "../server/artifact-validation.ts";
import { BlobStore, hashBytes } from "../server/blobs.ts";
import { type DocumentRenderer, prepareFiles, validatePublication } from "../server/publication.ts";
import type { PublicationFile } from "../shared/artifacts.ts";

// Build historical state before opening the isolated test daemon. New publication
// APIs must reject this shape, so compatibility checks cannot use them to seed it.
export async function seedLegacyMarkdownArtifact(
  databasePath: string,
  versions: PublicationFile[][],
  render: DocumentRenderer = renderArtifactDocument,
): Promise<string> {
  if (await Bun.file(databasePath).exists()) throw new Error("Fixture requires a new database");
  const db = new Database(databasePath);
  const blobs = new BlobStore(join(`${databasePath}.artifacts`, "blobs"));
  const id = `artifact_${randomUUID().replaceAll("-", "")}`;
  const time = "2026-09-01T00:00:00.000Z";
  try {
    createArtifactTables(db);
    db.exec(`PRAGMA user_version = ${ARTIFACT_SCHEMA_VERSION}`);
    db.query(`INSERT INTO artifacts(id,kind,title,created_by,created_at,updated_at)
      VALUES (?,'html','Historical Markdown page','human',?,?)`).run(id, time, time);
    for (const [index, members] of versions.entries()) {
      const seq = index + 1;
      const publication = validatePublication({
        actor: { role: "human", sessionId: null },
        expectedSeq: index,
        publicationKey: `legacy-${seq}`,
        content: { kind: "files", files: members },
      });
      const files = await prepareFiles(publication, blobs, render);
      const hash = hashBytes(
        canonicalJson({
          kind: "html",
          entrypoint: "index.md",
          files: files.map(({ path, mediaType, hash }) => ({ path, mediaType, hash })),
        }),
      );
      db.transaction(() => {
        db.query("UPDATE artifacts SET next_seq = ? WHERE id = ?").run(seq + 1, id);
        db.query(`INSERT INTO artifact_versions
          (artifact_id,seq,kind,publication_key,content_hash,published_by,entrypoint,file_count,created_at)
          VALUES (?,?,'html',?,?,'human','index.md',?,?)`).run(
          id,
          seq,
          publication.publicationKey,
          hash,
          files.length,
          time,
        );
        for (const file of files) {
          for (const blob of [file, file.rendered]) {
            if (blob)
              db.query("INSERT OR IGNORE INTO blobs VALUES (?,?,?)").run(
                blob.hash,
                blob.byteLength,
                time,
              );
          }
          db.query(`INSERT INTO version_files
            (artifact_id,version_seq,artifact_kind,path,media_type,blob_hash,rendered_blob_hash,renderer_revision)
            VALUES (?,?,'html',?,?,?,?,?)`).run(
            id,
            seq,
            file.path,
            file.mediaType,
            file.hash,
            file.rendered?.hash ?? null,
            file.rendered?.revision ?? null,
          );
        }
        db.query(
          "UPDATE artifact_versions SET published_at = ? WHERE artifact_id = ? AND seq = ?",
        ).run(time, id, seq);
      }).immediate();
    }
    return id;
  } finally {
    db.close();
  }
}
