import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { DaemonInfo } from "../server/config.ts";
import { remoteArtifactLocation } from "./daemon-client.ts";

test("remote publisher discovery never borrows a different daemon's credential", () => {
  const token = randomBytes(32).toString("base64url");
  const local: DaemonInfo = {
    url: "http://localhost:8791",
    token,
    pid: 1,
    port: 8791,
    version: "fixture",
  };
  expect(remoteArtifactLocation("https://remote.example", undefined, local).token).toBe("");
  expect(remoteArtifactLocation("http://localhost:8791/another-app", undefined, local).token).toBe(
    "",
  );
  expect(remoteArtifactLocation("http://localhost:8792", undefined, local).token).toBe("");
  expect(remoteArtifactLocation("http://localhost:8791/", undefined, local).token).toBe(token);
  const supplied = randomBytes(32).toString("base64url");
  expect(remoteArtifactLocation("https://remote.example", supplied, local).token).toBe(supplied);
  expect(() => remoteArtifactLocation("https://remote.example/#fragment", supplied, local)).toThrow(
    "R3_URL",
  );
});
