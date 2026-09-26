import { expect, test } from "bun:test";
import { Writable } from "node:stream";
import { writeArtifactOutput } from "./artifact-output.ts";

test("stdout completion waits for the stream callback and rejects asynchronous write errors", async () => {
  const entered = Promise.withResolvers<(error?: Error | null) => void>();
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      entered.resolve(callback);
    },
  });
  let completed = false;
  const writing = writeArtifactOutput("Buffered feedback", stream).then(() => {
    completed = true;
  });
  const callback = await entered.promise;
  expect(completed).toBe(false);
  callback();
  await writing;
  expect(completed).toBe(true);
  const broken = new Writable({
    write(_chunk, _encoding, done) {
      queueMicrotask(() => done(new Error("Broken pipe")));
    },
  });
  await expect(writeArtifactOutput("Feedback", broken)).rejects.toThrow("Broken pipe");
});
