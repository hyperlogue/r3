import type { Writable } from "node:stream";

export function writeArtifactOutput(
  text: string | Uint8Array,
  stream: Writable = process.stdout,
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.write(text, (error) => {
      // An errored write also emits error; retain the listener to consume it.
      if (error) reject(error);
      else {
        stream.off("error", reject);
        resolve();
      }
    });
  });
}
