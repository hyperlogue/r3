import { expect, test } from "bun:test";
import { artifactAuthSettings, artifactProjectSettings } from "./artifact-config.ts";

test("token inactivity defaults to 14 days and uses environment then persisted configuration", () => {
  expect(artifactAuthSettings({}, {})).toEqual({ authTokenIdleDays: 14 });
  expect(artifactAuthSettings({}, { authTokenIdleDays: 30 })).toEqual({ authTokenIdleDays: 30 });
  expect(
    artifactAuthSettings({ R3_AUTH_TOKEN_IDLE_DAYS: " 7 " }, { authTokenIdleDays: 30 }),
  ).toEqual({ authTokenIdleDays: 7 });
  expect(artifactAuthSettings({ R3_AUTH_TOKEN_IDLE_DAYS: " " }, { authTokenIdleDays: 30 })).toEqual(
    { authTokenIdleDays: 30 },
  );
  for (const value of ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"])
    expect(() => artifactAuthSettings({ R3_AUTH_TOKEN_IDLE_DAYS: value }, {})).toThrow(
      "positive integer",
    );
});

test("project grouping defaults to remote with explicit manual and environment overrides", () => {
  expect(artifactProjectSettings({}, {})).toMatchObject({ mode: "remote" });
  expect(artifactProjectSettings({}, { projectGrouping: "manual" })).toMatchObject({
    mode: "manual",
  });
  expect(
    artifactProjectSettings({ R3_PROJECT_GROUPING: "remote" }, { projectGrouping: "manual" }),
  ).toMatchObject({ mode: "remote" });
  expect(() => artifactProjectSettings({ R3_PROJECT_GROUPING: "unknown" }, {})).toThrow(
    "remote or manual",
  );
});
