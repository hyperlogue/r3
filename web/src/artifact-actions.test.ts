import { expect, test } from "bun:test";
import { ArtifactApiError } from "../../shared/artifact-client.ts";
import {
  ARTIFACT_BULK_ARCHIVE_LIMIT,
  type ArtifactBulkArchiveBody,
} from "../../shared/artifacts.ts";
import { artifactApi } from "./artifact-api.ts";
import { actOnArtifacts } from "./components/ArtifactActionDialog.tsx";

test("bulk delete continues after failure and treats already deleted artifacts as skipped", async () => {
  const attempted: string[] = [];
  const results = await actOnArtifacts(
    ["failed", "missing", "ok"].map((id) => ({ id, title: id, state: "active" })),
    "delete",
    "",
    new Map(),
    {
      ...artifactApi,
      delete: async (id) => {
        attempted.push(id);
        if (id === "failed") throw new Error("Temporary failure");
        if (id === "missing") throw new ArtifactApiError(404, null, "Not found");
        return { ok: true };
      },
    },
  );
  expect(attempted).toEqual(["failed", "missing", "ok"]);
  expect(results.map((r) => [r.id, r.state])).toEqual([
    ["failed", "failed"],
    ["missing", "skipped"],
    ["ok", "done"],
  ]);
});
test("bulk archive sends one request and reports mixed outcomes without detail reads", async () => {
  const keys = new Map<string, string>();
  const sent: Omit<ArtifactBulkArchiveBody, "actor">[] = [];
  const api = {
    ...artifactApi,
    bulkArchive: async (body: Omit<ArtifactBulkArchiveBody, "actor">) => {
      sent.push(body);
      return {
        results: [
          { id: "old", state: "skipped" as const, reason: "already_archived" as const },
          { id: "missing", state: "failed" as const, status: 404, error: "Artifact not found" },
          { id: "new", state: "failed" as const, status: 502, error: "Agent notification failed" },
        ],
      };
    },
    detail: async () => {
      throw new Error("Unexpected detail read");
    },
    lifecycle: async () => {
      throw new Error("Unexpected individual archive");
    },
  };
  const items = ["old", "missing", "new"].map((id) => ({
    id,
    title: id,
    state: "active" as const,
  }));
  expect(await actOnArtifacts(items, "archive", "Finished review", keys, api)).toEqual([
    { id: "old", state: "skipped" },
    { id: "missing", state: "failed", warning: "Artifact not found" },
    { id: "new", state: "failed", warning: "Agent notification failed" },
  ]);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({
    items: items.map(({ id }) => ({ id, operationKey: keys.get(id)! })),
    comment: { body: "Finished review" },
  });
  expect(new Set(keys.values()).size).toBe(3);
});
test("bulk archive bounds requests, continues after transport failure, and keeps retry keys", async () => {
  const keys = new Map<string, string>();
  const requests: Omit<ArtifactBulkArchiveBody, "actor">[] = [];
  const items = Array.from({ length: ARTIFACT_BULK_ARCHIVE_LIMIT + 1 }, (_, i) => ({
    id: `artifact_${i}`,
    title: null,
    state: "active" as const,
  }));
  const api = {
    ...artifactApi,
    bulkArchive: async (body: Omit<ArtifactBulkArchiveBody, "actor">) => {
      requests.push(body);
      if (requests.length === 1) throw new Error("Response lost");
      return {
        results: body.items.map(({ id }) => ({
          id,
          state: "archived" as const,
          eventId: `event_${id}`,
          replayed: true,
          notification: { state: "not_repeated" as const },
        })),
      };
    },
  };
  const results = await actOnArtifacts(items, "archive", "", keys, api);
  expect(requests.map((body) => body.items.length)).toEqual([ARTIFACT_BULK_ARCHIVE_LIMIT, 1]);
  expect(results.filter((result) => result.state === "failed")).toHaveLength(
    ARTIFACT_BULK_ARCHIVE_LIMIT,
  );
  expect(results.at(-1)?.state).toBe("done");
  const retry = await actOnArtifacts(
    items.slice(0, ARTIFACT_BULK_ARCHIVE_LIMIT),
    "archive",
    "",
    keys,
    api,
  );
  expect(requests[2]).toEqual(requests[0]);
  expect(retry.every((result) => result.state === "done")).toBe(true);
});
