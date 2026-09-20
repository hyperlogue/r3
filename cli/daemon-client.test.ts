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
    agentSocket: "/path/to/private/agents.sock",
  };
  expect(remoteArtifactLocation("https://remote.example", undefined, local).token).toBe("");
  expect(remoteArtifactLocation("http://localhost:8791/another-app", undefined, local).token).toBe(
    "",
  );
  expect(remoteArtifactLocation("http://localhost:8792", undefined, local).token).toBe("");
  expect(remoteArtifactLocation("http://localhost:8791/", undefined, local).token).toBe(token);
  expect(remoteArtifactLocation("http://localhost:8791/", undefined, local).agentSocket).toBe(
    local.agentSocket,
  );
  expect(
    remoteArtifactLocation("https://remote.example", undefined, local).agentSocket,
  ).toBeUndefined();
  expect(
    remoteArtifactLocation("http://localhost:8791/another-app", undefined, local).agentSocket,
  ).toBeUndefined();
  const supplied = randomBytes(32).toString("base64url");
  expect(remoteArtifactLocation("https://remote.example", supplied, local).token).toBe(supplied);
  expect(() => remoteArtifactLocation("https://remote.example/#fragment", supplied, local)).toThrow(
    "R3_URL",
  );
});
