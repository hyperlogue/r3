import { expect, test } from "bun:test";
import { ArtifactApiError } from "../../shared/artifact-client.ts";
import { artifactApi } from "./artifact-api.ts";
import { artifactFixture } from "./artifact-fixtures.ts";
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

test("bulk archive skips existing archives and distinguishes committed notification failures", async () => {
  const keys = new Map<string, string>();
  const sent: string[] = [];
  const api = {
    ...artifactApi,
    detail: async (id: string) => ({
      ...artifactFixture,
      id,
      state: id === "old" ? ("archived" as const) : ("active" as const),
    }),
    lifecycle: async (id: string, body: Parameters<typeof artifactApi.lifecycle>[1]) => {
      sent.push(`${id}:${body.message}`);
      return {
        replayed: false,
        notification: { state: "failed" as const, error: "Offline" },
        event: {
          id: "event_test",
          seq: 1,
          artifactId: id,
          actor: { role: "human" as const, sessionId: null },
          event: "archived" as const,
          operationKey: body.operationKey,
          message: body.message ?? null,
          createdAt: artifactFixture.createdAt,
        },
      };
    },
  };
  const results = await actOnArtifacts(
    ["old", "new"].map((id) => ({ id, title: id, state: "active" })),
    "archive",
    "Finished review",
    keys,
    api,
  );
  expect(sent).toEqual(["new:Finished review"]);
  expect(results).toEqual([
    { id: "old", state: "skipped" },
    { id: "new", state: "done", warning: "Archived, but agent notification failed" },
  ]);
  expect(keys.has("new")).toBe(true);
});
