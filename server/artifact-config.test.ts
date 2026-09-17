import { expect, test } from "bun:test";
import { artifactPreviewSettings, artifactProjectSettings } from "./artifact-config.ts";

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

test("automatic previews need no second listener or port, including the last application port", () => {
  expect(artifactPreviewSettings({}, {}, 65535)).toEqual({});
  expect(artifactPreviewSettings({ R3_PREVIEW_PORT: "9001" }, {}, 9000)).toEqual({});
});

test("an explicit preview endpoint retains environment precedence and distinct port validation", () => {
  expect(artifactPreviewSettings({}, { previewBaseUrl: "https://preview.example" }, 9000)).toEqual({
    port: 9001,
    baseUrl: "https://preview.example",
  });
  expect(
    artifactPreviewSettings(
      { R3_PREVIEW_BASE_URL: "https://edge.example:8443", R3_PREVIEW_PORT: "9002" },
      { previewBaseUrl: "https://preview.example", previewPort: 9003 },
      9000,
    ),
  ).toEqual({ port: 9002, baseUrl: "https://edge.example:8443" });
  expect(() =>
    artifactPreviewSettings(
      { R3_PREVIEW_PORT: "9000" },
      { previewBaseUrl: "https://preview.example" },
      9000,
    ),
  ).toThrow("different port");
  expect(() =>
    artifactPreviewSettings({}, { previewBaseUrl: "https://preview.example" }, 65535),
  ).toThrow("between 1 and 65535");
});
