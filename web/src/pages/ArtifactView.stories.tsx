import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import type { ArtifactDetail, ArtifactFile, ArtifactSource } from "../../../shared/artifacts.ts";
import { artifactDrafts } from "../artifact-drafts.ts";
import {
  artifactFixture,
  artifactFixtureFeedback,
  artifactFixtureVersion,
} from "../artifact-fixtures.ts";
import { singleRound } from "../components/_fixtures.ts";
import { setFeedbackMode } from "../settings.ts";
import { phoneViewport } from "../storyViewport.ts";
import { type ArtifactRenderer, ArtifactWorkspace } from "./ArtifactView.tsx";

const files: ArtifactFile[] = [
  {
    path: "index.md",
    mediaType: "text/markdown",
    hash: "fixture-markdown",
    byteLength: 128,
    renderedHash: "fixture-retained-html",
    rendererRevision: "fixture-renderer",
  },
  {
    path: "data.csv",
    mediaType: "text/csv",
    hash: "fixture-csv",
    byteLength: 20,
    renderedHash: null,
    rendererRevision: null,
  },
];
const source: ArtifactSource = {
  artifactId: artifactFixture.id,
  versionSeq: 1,
  path: "index.md",
  hash: files[0].hash,
  byteLength: files[0].byteLength,
  mediaType: files[0].mediaType,
  kind: "text",
  language: "markdown",
  lines: [
    "# Team workspace",
    "",
    "A place to compare the proposals.",
    "[View the comparison](#comparison)",
  ].map((text, i) => ({ lineNo: i + 1, text, html: text })),
};
const detail: ArtifactDetail = {
  ...artifactFixture,
  feedback: [
    artifactFixtureFeedback,
    {
      ...artifactFixtureFeedback,
      id: "feedback_source",
      body: "Could this link label explain the destination?",
      target: {
        kind: "source",
        versionSeq: 1,
        path: "index.md",
        locator: { start: 4, end: 4, quote: source.lines[3].text },
      },
      replies: [],
    },
  ],
  versions: [
    artifactFixtureVersion,
    { ...artifactFixtureVersion, seq: 2, label: "Clearer navigation" },
  ],
};
const queryData: [unknown[], unknown][] = [
  [
    ["theme-style", "github"],
    {
      lightBg: "#ffffff",
      darkBg: "#24292e",
      lightFg: "#24292e",
      darkFg: "#e1e4e8",
      css: "html:not(.dark) .sl1{color:#005cc5}html.dark .sd1{color:#79b8ff}",
    },
  ],
  [["artifact-viewed", detail.id], []],
  [["artifact-watchers", detail.id], []],
  ...[1, 2].flatMap((seq): [unknown[], unknown][] => [
    [["artifact-files", detail.id, seq], files],
    [["artifact-source", detail.id, seq, "index.md", "github"], { ...source, versionSeq: seq }],
    [
      ["artifact-source", detail.id, seq, "data.csv", "github"],
      {
        ...source,
        versionSeq: seq,
        path: "data.csv",
        lines: [{ lineNo: 1, text: "team,size", html: "team,size" }],
      },
    ],
    [["artifact-diff", detail.id, seq, "github"], singleRound[0].files],
  ]),
];
// Trusted presentation fixture: preview isolation is exercised against the real
// preview server in browser acceptance, never simulated by this story.
const preview: ArtifactRenderer = ({ commenting, onTarget, version, path }) => (
  <article data-preview-fixture className="min-h-80 bg-white p-8 text-neutral-900">
    <h1 className="mb-4 text-3xl font-semibold">Team workspace</h1>
    <p>A place to compare the proposals.</p>
    <button
      type="button"
      className="mt-4 text-primary-600 underline"
      onClick={() => {
        if (commenting)
          onTarget({
            kind: "rendered",
            versionSeq: version.seq,
            path,
            locator: { selector: "button", quote: "View the comparison" },
          });
      }}
    >
      View the comparison
    </button>
  </article>
);

const meta = {
  title: "Pages/ArtifactWorkspace",
  component: ArtifactWorkspace,
  args: { detail, initialSearch: "?version=1", renderPreview: preview },
  parameters: { queryData },
  loaders: [
    () => {
      artifactDrafts.clear(detail.id);
      setFeedbackMode("expanded");
      return {};
    },
  ],
  decorators: [
    (Story) => (
      <div className="flex h-[calc(100dvh-3rem)] min-h-0 flex-col border border-neutral-300 dark:border-neutral-700">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ArtifactWorkspace>;
export default meta;
type Story = StoryObj<typeof meta>;

const treePaths = [
  "README.md",
  "src/index.ts",
  "docs/intro.md",
  "src/lib/z.ts",
  "src/lib/a.ts",
  "docs/api.md",
  "src/A.ts",
  "LICENSE",
];
export const TreeOrderedFiles: Story = {
  args: {
    detail: {
      ...detail,
      feedback: [],
      versions: [
        { ...artifactFixtureVersion, kind: "files", entrypoint: null, fileCount: treePaths.length },
      ],
    },
  },
  parameters: {
    queryData: [
      ...queryData,
      [
        ["artifact-files", detail.id, 1],
        treePaths.map((path) => ({
          ...files[0],
          path,
          mediaType: "text/plain",
          renderedHash: null,
        })),
      ],
      ...treePaths.map((path) => [
        ["artifact-source", detail.id, 1, path, "github"],
        {
          ...source,
          path,
          lines: [{ lineNo: 1, text: path, html: path }],
        },
      ]),
    ],
  },
};
export const Files: Story = {};
const fallbackFiles = (["binary", "oversize"] as const).map((kind) => ({
  ...files[1],
  path: kind === "binary" ? "archive.bin" : "large.txt",
  mediaType: kind === "binary" ? "application/octet-stream" : "text/plain",
  sourceKind: kind,
}));
export const DownloadFallback: Story = {
  parameters: {
    queryData: [
      ...queryData,
      [["artifact-files", detail.id, 1], fallbackFiles],
      ...fallbackFiles.map((file) => [
        ["artifact-source", detail.id, 1, file.path, "github"],
        { ...source, ...file, kind: file.sourceKind, language: null, lines: [] },
      ]),
    ],
  },
};

export const AllFiles: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvasElement.querySelectorAll("[data-file]")).toHaveLength(2);
    await userEvent.click(canvas.getByTitle("Fold all files"));
    await waitFor(() =>
      expect(canvasElement.querySelectorAll('[data-file] button[title="Expand"]')).toHaveLength(2),
    );
    await userEvent.click(canvas.getByTitle("Unfold all files"));
    await waitFor(() =>
      expect(canvasElement.querySelectorAll('[data-file] button[title="Collapse"]')).toHaveLength(
        2,
      ),
    );
  },
};
export const Rendered: Story = {
  args: { initialSearch: "?version=1&view=rendered&file=index.md" },
};
export const LongRenderedMarkdown: Story = {
  ...Rendered,
  args: {
    ...Rendered.args,
    renderPreview: () => (
      <article className="space-y-6 bg-white p-8 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
        <h1 className="text-2xl font-semibold">Full-height Markdown</h1>
        {Array.from({ length: 12 }, (_, index) => (
          <section key={index}>
            <h2 className="mb-3 text-lg font-semibold">Section {index + 1}</h2>
            <p>
              The rendered document expands inside this file card. Scroll the content pane to reach
              later sections and the next file; folding the card collapses the document.
            </p>
          </section>
        ))}
      </article>
    ),
  },
};
export const LongRenderedMarkdownDark: Story = {
  ...LongRenderedMarkdown,
  globals: { theme: "dark" },
};
export const Diff: Story = {
  args: {
    detail: {
      ...detail,
      kind: "diff",
      feedback: [],
      versions: detail.versions.map((version) => ({
        ...version,
        kind: "diff",
        entrypoint: null,
        fileCount: null,
      })),
    },
  },
};
export const Html: Story = {
  args: {
    detail: {
      ...detail,
      kind: "html",
      feedback: [artifactFixtureFeedback],
      versions: detail.versions.map((version) => ({
        ...version,
        kind: "html",
        entrypoint: "index.md",
        fileCount: 2,
      })),
    },
  },
};
export const OldContextLocate: Story = {
  args: {
    detail: {
      ...detail,
      kind: "diff",
      versions: detail.versions.map((version) => ({
        ...version,
        kind: "diff",
        entrypoint: null,
        fileCount: null,
      })),
      feedback: [
        {
          ...artifactFixtureFeedback,
          id: "feedback_old_context",
          replies: [],
          target: {
            kind: "diff",
            versionSeq: 1,
            path: "server/db.ts",
            locator: { side: "old", start: 12, end: 12, quote: "  return db;" },
          },
        },
      ],
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Version 1 · diff · server/db.ts:12-12 (old)" }),
    );
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-old-line="12"].r3-active-line')).not.toBeNull(),
    );
    await expect(canvasElement.querySelector('[data-new-line="12"].r3-active-line')).toBeNull();
  },
};
export const HistoricalVersionUnavailable: Story = {
  args: { initialSearch: "?version=7&view=source&file=index.md" },
};
export const Mobile: Story = { parameters: phoneViewport() };
export const CollapsedComposer: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Hide feedback" }));
    const gutter = canvasElement.querySelector(
      '[data-file="index.md"] [data-line="4"] [data-gutter]',
    ) as HTMLElement;
    await userEvent.click(gutter);
    const body = within(document.body);
    await expect(canvas.getByRole("button", { name: "Show feedback" })).toBeVisible();
    await expect(body.getByRole("button", { name: "Close composer" })).toBeVisible();
    await expect(body.getByRole("textbox", { name: "Feedback" })).toBeVisible();
    await userEvent.type(body.getByRole("textbox", { name: "Feedback" }), "A floating draft.");
    await expect(artifactDrafts.get(detail.id)?.target.kind).toBe("source");
  },
};
export const FloatingPanelAndThread: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.dblClick(
      canvasElement.querySelector<HTMLElement>("[data-feedback-mode] .cursor-col-resize")!,
    );
    const content = canvasElement.querySelector("[data-artifact-content]")!;
    const expandedWidth = content.getBoundingClientRect().width;
    await userEvent.click(canvas.getByRole("button", { name: "Float feedback" }));
    const width = content.getBoundingClientRect().width;
    await expect(width).toBeGreaterThan(expandedWidth);
    await userEvent.click(canvas.getByRole("button", { name: "Hide feedback" }));
    await expect(content.getBoundingClientRect().width).toBe(width);
    const row = canvasElement.querySelector('[data-fb-id="feedback_source"] code') as HTMLElement;
    await userEvent.click(row);
    const thread = canvas.getByRole("dialog", { name: "Feedback thread" });
    await expect(canvas.getByRole("button", { name: "Show feedback" })).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "Expand feedback" })).toBeNull();
    await expect(canvas.queryByRole("button", { name: "Float feedback" })).toBeNull();
    await userEvent.click(within(thread).getByRole("button", { name: "Reply" }));
    await userEvent.type(
      within(thread).getByRole("textbox", { name: "Reply" }),
      "Keep this thread draft.",
    );
    await userEvent.click(within(thread).getByRole("button", { name: "Close thread" }));
    await expect(artifactDrafts.get(detail.id, "feedback_source")?.body).toBe(
      "Keep this thread draft.",
    );
    await userEvent.click(row);
    await userEvent.click(canvas.getByRole("button", { name: "Open all feedback" }));
    await expect(canvas.queryByRole("dialog", { name: "Feedback thread" })).toBeNull();
    await expect(
      canvasElement.querySelector<HTMLElement>("[data-feedback-mode]")?.dataset.feedbackMode,
    ).toBe("floating");
    await expect(content.getBoundingClientRect().width).toBe(width);
    await userEvent.click(canvas.getByRole("button", { name: "Hide feedback" }));
    await userEvent.click(canvas.getByRole("button", { name: "Show feedback" }));
    await expect(
      canvasElement.querySelector<HTMLElement>("[data-feedback-mode]")?.dataset.feedbackMode,
    ).toBe("floating");
  },
};
export const VirtualizedLocate: Story = {
  args: {
    detail: {
      ...detail,
      feedback: [
        {
          ...artifactFixtureFeedback,
          id: "feedback_far",
          replies: [],
          body: "Keep the far end reachable.",
          target: {
            kind: "source",
            versionSeq: 1,
            path: "index.md",
            locator: { start: 1800, end: 1800, quote: "Line 1800" },
          },
        },
      ],
    },
  },
  parameters: {
    queryData: [
      ...queryData.filter(([key]) => key[0] !== "artifact-source"),
      [
        ["artifact-source", detail.id, 1, "index.md", "github"],
        {
          ...source,
          lines: Array.from({ length: 2000 }, (_, index) => ({
            lineNo: index + 1,
            text: `Line ${index + 1}`,
            html: `Line ${index + 1}`,
          })),
        },
      ],
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Version 1 · source · index.md:1800-1800" }),
    );
    await waitFor(() =>
      expect(canvasElement.querySelector('[data-line="1800"].r3-active-line')).not.toBeNull(),
    );
    await expect(canvasElement.querySelectorAll("[data-line]").length).toBeLessThan(300);
  },
};
export const NewPublication: Story = {
  render: (args) => {
    const [current, setCurrent] = useState({ ...detail, versions: [detail.versions[0]] });
    return (
      <>
        <button type="button" className="p-2 text-sm underline" onClick={() => setCurrent(detail)}>
          Simulate publication
        </button>
        <ArtifactWorkspace {...args} initialSearch="" detail={current} />
      </>
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const content = canvasElement.querySelector("[data-artifact-content]")!;
    const height = content.getBoundingClientRect().height;
    await expect(canvas.getByRole("button", { name: "Published version" })).toHaveValue("1");
    await userEvent.click(canvas.getByRole("button", { name: "Simulate publication" }));
    await expect(canvas.getByRole("button", { name: "Published version" })).toHaveValue("1");
    await expect(canvas.getByRole("button", { name: "Open latest · 2" })).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Open latest · 2" }).closest("[data-app-header]"),
    ).not.toBeNull();
    await expect(
      within(content as HTMLElement).queryByRole("button", { name: /Open latest/ }),
    ).toBeNull();
    await expect(content.getBoundingClientRect().height).toBe(height);
    await userEvent.click(canvas.getByRole("button", { name: "Open latest · 2" }));
    await expect(canvas.getByRole("button", { name: "Published version" })).toHaveValue("2");
    await expect(canvas.queryByRole("button", { name: "Open latest · 2" })).toBeNull();
  },
};
export const DraftAndNativeLocate: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const gutter = canvasElement.querySelector(
      '[data-file="index.md"] [data-line="4"] [data-gutter]',
    ) as HTMLElement;
    await userEvent.click(gutter);
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Feedback" }),
      "Keep this exact source target.",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Rendered" }));
    await userEvent.click(canvas.getByRole("button", { name: "Published version" }));
    await userEvent.click(canvas.getByRole("option", { name: /Version 2/ }));
    await expect(artifactDrafts.get(detail.id)?.target).toEqual({
      kind: "source",
      versionSeq: 1,
      path: "index.md",
      locator: { start: 4, end: 4, quote: source.lines[3].text },
    });
    await userEvent.click(
      canvas.getByRole("button", { name: "Version 1 · source · index.md:4-4" }),
    );
    await expect(canvas.getByRole("button", { name: "Published version" })).toHaveValue("1");
    await expect(canvas.getByRole("button", { name: "Source" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(canvas.getByRole("textbox", { name: "Feedback" })).toHaveValue(
      "Keep this exact source target.",
    );
    await expect(canvasElement.querySelector('[data-line="4"].r3-active-line')).not.toBeNull();
  },
};
