import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { canonicalJson } from "../server/artifact-validation.ts";
import { BlobStore, hashBytes } from "../server/blobs.ts";
import { ArtifactClient } from "../shared/artifact-client.ts";
import type { ArtifactSearchResponse } from "../shared/artifact-search.ts";
import type { ArtifactComment, ArtifactThread } from "../shared/artifacts.ts";
import { runArtifactCommand } from "./artifact-commands.ts";

test("migrated legacy IDs support the same HTTP and CLI operations as new IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-legacy-ids-"));
  const databasePath = join(root, "store.sqlite");
  const artifactId = "artifact_kept";
  const time = "2026-10-01T00:00:00.000Z";
  const human = { role: "human", sessionId: null } as const;
  const legacy = [
    ["feedback_kept", "reply_kept"],
    ["discussion_kept", "comment_kept"],
  ] as const;
  const replyInput = (threadId: string) => ({
    actor: human,
    body: "Legacy follow-up",
    operationKey: `retry-${threadId}`,
  });
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4HyD3H4QZYAwAV6YJsVhH600AAAAASUVORK5CYII=",
    "base64",
  );
  try {
    const blob = await new BlobStore(`${databasePath}.artifacts/blobs`).put(bytes);
    const db = new Database(databasePath);
    try {
      db.exec(
        await readFile(new URL("../server/fixtures/schema-v14.sql", import.meta.url), "utf8"),
      );
      db.exec("PRAGMA foreign_keys=ON; INSERT INTO artifact_activity_coverage VALUES (1,NULL)");
      db.query(`INSERT INTO artifacts(id,kind,created_by,created_at,updated_at)
        VALUES (?,'files','human',?,?)`).run(artifactId, time, time);
      db.query("INSERT INTO blobs(hash,byte_length,created_at) VALUES (?,?,?)").run(
        blob.hash,
        blob.byteLength,
        time,
      );
      for (const [index, [threadId, commentId]] of legacy.entries()) {
        db.query(`INSERT INTO discussions(id,artifact_id,artifact_kind,author,body,target_kind,created_at,updated_at)
          VALUES (?,?,'files','human','Original opening','artifact',?,?)`).run(
          threadId,
          artifactId,
          time,
          time,
        );
        db.query(`INSERT INTO comments(id,discussion_id,artifact_id,artifact_kind,author,body,created_at)
          VALUES (?,?,?,'files','human',?,?)`).run(
          commentId,
          threadId,
          artifactId,
          replyInput(threadId).body,
          time,
        );
        db.query("INSERT INTO message_operations VALUES (?,?,?,NULL,?)").run(
          artifactId,
          replyInput(threadId).operationKey,
          hashBytes(
            canonicalJson({ kind: "reply", parentId: threadId, input: replyInput(threadId) }),
          ),
          commentId,
        );
        db.query(`INSERT INTO message_attachments(id,artifact_id,discussion_id,position,blob_hash,media_type,width,height)
          VALUES (?,?,?,0,?,'image/png',2,2)`).run(
          `image_${String(index + 1).repeat(32)}`,
          artifactId,
          threadId,
          blob.hash,
        );
      }
    } finally {
      db.close();
    }
    const storage = await openArtifactStorage({ databasePath, clock: () => time });
    try {
      expect(storage.migration?.migrated).toBe(true);
      const token = randomBytes(32).toString("base64url");
      const api = createArtifactApi(storage, {
        token,
        version: "test",
        requireLogin: false,
        allowedHost: (host) => host === "localhost",
      });
      try {
        const client = new ArtifactClient({
          url: "http://localhost",
          token,
          fetch: async (request) => {
            request.headers.set("host", "localhost");
            return api.app.request(request);
          },
        });
        const command = async (name: string, args: string[]) => {
          const output: Uint8Array[] = [];
          const code = await runArtifactCommand(name, args, {
            client,
            cwd: root,
            environment: { R3_AGENT_SESSION: "test-agent" },
            stdin: async () => "",
            write: (text) => {
              output.push(typeof text === "string" ? Buffer.from(text) : text);
            },
            error: (message) => {
              throw new Error(message);
            },
          });
          expect(code).toBe(0);
          return Buffer.concat(output);
        };
        await client.checkProtocol();
        for (const [threadId, commentId] of legacy) {
          const thread = await client.json<ArtifactThread>("GET", `/api/threads/${threadId}`);
          expect(thread.id).toBe(threadId);
          expect(thread.comments.map((comment) => comment.id)).toEqual([
            `comment_${threadId}`,
            commentId,
          ]);
          const image = thread.comments[0]!.attachments![0]!;
          expect(await command("comment", ["image", artifactId, "--image", image.id])).toEqual(
            bytes,
          );
          const replay = await client.json<ArtifactComment>(
            "POST",
            `/api/threads/${threadId}/comments`,
            replyInput(threadId),
          );
          expect(replay.id).toBe(commentId);
          expect(storage.conversations.get(threadId).comments).toHaveLength(2);
          for (const id of [`comment_${threadId}`, commentId]) {
            const shown = JSON.parse((await command("comment", ["show", id, "--json"])).toString());
            expect(shown).toMatchObject({ id, threadId });
            const edited = JSON.parse(
              (await command("comment", ["edit", id, "--human", "-m", `Edited ${id}`])).toString(),
            );
            expect(edited).toMatchObject({ id, threadId, body: `Edited ${id}` });
          }
          const fetched = await command("comment", [
            "fetch",
            artifactId,
            "--threads",
            threadId,
            "--human",
          ]);
          expect(fetched.toString()).toContain(`Edited ${commentId}`);
          expect(storage.conversations.comment(commentId).sentAt).toBe(time);
          await command("claim", [threadId]);
          expect(storage.conversations.get(threadId).claim?.threadId).toBe(threadId);
          const added = JSON.parse(
            (await command("comment", [threadId, "-m", "Agent follow-up"])).toString(),
          );
          expect(added.threadId).toBe(threadId);
          expect(added.id).toMatch(/^comment_[a-f0-9]{32}$/);
          expect(storage.conversations.get(threadId).claim).toBeNull();
          await command("thread", ["edit", threadId, "--status", "resolved", "--human"]);
          expect(storage.conversations.get(threadId).status).toBe("resolved");
        }
        const results = await client.json<ArtifactSearchResponse>(
          "GET",
          "/api/search?q=Edited&type=conversation",
        );
        expect(new Set(results.matches.map((match) => match.threadId))).toEqual(
          new Set(legacy.map(([id]) => id)),
        );
        const current = JSON.parse(
          (await command("thread", ["add", artifactId, "-m", "New topic", "--human"])).toString(),
        );
        expect(current.id).toMatch(/^thread_[a-f0-9]{32}$/);
        expect(current.comments[0].id).toBe(`comment_${current.id}`);
        for (const [threadId, commentId] of legacy) {
          await command("thread", ["delete", threadId, "--human"]);
          await expect(client.json("GET", `/api/comments/${commentId}`)).rejects.toMatchObject({
            status: 404,
          });
        }
        expect(storage.conversations.list(artifactId).map((thread) => thread.id)).toEqual([
          current.id,
        ]);
      } finally {
        api.close();
      }
    } finally {
      storage.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
