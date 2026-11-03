import { describe, expect, test } from "bun:test";
import { ArtifactApiError } from "../../shared/artifact-client.ts";
import type { ArtifactDraft } from "./artifact-drafts.ts";
import { DiscussionOutbox, retryableMessageError } from "./discussion-outbox.ts";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
  };
}
const draft: ArtifactDraft = {
  body: "Recover this reply",
  target: { kind: "artifact" },
  context: { versionSeq: null, representation: null },
};

describe("durable discussion operations", () => {
  test("reload preserves exact identity, target and attachment references", () => {
    const disk = storage();
    const queue = new DiscussionOutbox(disk);
    queue.enqueue(
      "artifact",
      {
        ...draft,
        attachments: [{ id: "image", width: 1, height: 1, byteLength: 10, mediaType: "image/png" }],
      },
      "thread",
    );
    const original = queue.snapshot()[0]!;
    queue.reject(original, new TypeError("Connection lost"));
    const restarted = new DiscussionOutbox(disk);
    expect(restarted.snapshot()[0]).toMatchObject({
      id: original.id,
      draft: original.draft,
      threadId: "thread",
      attempts: 1,
      failed: false,
    });
    restarted.retry(original.id);
    expect(restarted.snapshot()[0]!.draft.operationKey).toBe(original.id);
  });
  test("independent tabs retain each other's messages", () => {
    const disk = storage();
    const first = new DiscussionOutbox(disk);
    const second = new DiscussionOutbox(disk);
    first.enqueue("artifact", draft, "thread");
    second.enqueue("artifact", { ...draft, body: "Other tab" });
    first.reload();
    expect(first.snapshot()).toHaveLength(2);
    first.remove(first.snapshot()[0]!.id);
    second.reload();
    expect(second.snapshot()).toHaveLength(1);
  });
  test("a stale tab cannot resurrect an acknowledged operation on late failure", () => {
    const disk = storage();
    const first = new DiscussionOutbox(disk);
    first.enqueue("artifact", draft);
    const second = new DiscussionOutbox(disk);
    const pending = second.snapshot()[0]!;
    first.remove(pending.id);
    second.reject(pending, new TypeError("Late disconnect"));
    second.reload();
    expect(second.snapshot()).toHaveLength(0);
  });
  test("quota failure never accepts a message into volatile memory", () => {
    const disk = storage();
    disk.setItem = () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    };
    const queue = new DiscussionOutbox(disk);
    expect(() => queue.enqueue("artifact", draft)).toThrow();
    expect(queue.snapshot()).toHaveLength(0);
  });
  test("revocation rejects late preparation and late request failures", () => {
    const queue = new DiscussionOutbox(storage());
    const generation = queue.generation;
    queue.enqueue("artifact", draft);
    const pending = queue.snapshot()[0]!;
    queue.clear();
    queue.reject(pending, new TypeError("Disconnected"));
    expect(queue.snapshot()).toHaveLength(0);
    expect(() => queue.enqueue("artifact", draft, undefined, generation)).toThrow("cancelled");
  });
  test("permanent failures remain recoverable without automatic replay", () => {
    const queue = new DiscussionOutbox(storage());
    queue.enqueue("artifact", draft);
    queue.reject(queue.snapshot()[0]!, new ArtifactApiError(409, null, "Archived"));
    expect(queue.snapshot()[0]).toMatchObject({
      failed: true,
      error: "Archived",
      draft: { body: draft.body },
    });
    for (const status of [400, 401, 403, 404, 409, 413])
      expect(retryableMessageError(new ArtifactApiError(status, null, "Rejected"))).toBe(false);
    for (const status of [408, 429, 500, 502, 503, 504])
      expect(retryableMessageError(new ArtifactApiError(status, null, "Unavailable"))).toBe(true);
    expect(retryableMessageError(new DOMException("Timed out", "TimeoutError"))).toBe(true);
    expect(retryableMessageError(new Error("Missing image"))).toBe(false);
  });
});
