import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import type { ArtifactSearchResponse } from "../../../shared/artifact-search.ts";
import type { Artifact } from "../../../shared/artifacts.ts";
import { artifactFixture } from "../artifact-fixtures.ts";
import { librarySearchOptions, readLibraryState } from "../artifact-library.ts";
import { phoneViewport } from "../storyViewport.ts";
import { ArtifactHome } from "./ArtifactHome.tsx";

const latestVersion = {
  seq: 4,
  label: "Refined design",
  summary: "Clearer navigation and keyboard focus",
  publishedAt: artifactFixture.updatedAt,
};
const artifacts: Artifact[] = [
  {
    ...artifactFixture,
    latestVersion,
    id: "artifact_files",
    title: "Published documents",
    kind: "files",
    watching: true,
    projectId: "project_signal",
  },
  {
    ...artifactFixture,
    latestVersion,
    id: "artifact_html",
    title: "Interactive prototype",
    kind: "html",
    projectId: "project_signal",
    storage: { totalBytes: 3_500_000, latestVersionBytes: 1_250_000 },
  },
  {
    ...artifactFixture,
    latestVersion,
    id: "artifact_diff",
    title: "Stored code changes",
    kind: "diff",
    state: "archived",
  },
  {
    ...artifactFixture,
    latestVersion,
    id: "artifact_long",
    title: "A deliberately long artifact title for checking compact rows in narrow layouts",
    kind: "files",
    unhandledCount: 0,
    projectId: "project_atlas",
    working: true,
  },
  {
    ...artifactFixture,
    latestVersion: null,
    id: "artifact_unpublished",
    title: "Getting started",
    kind: "files",
    unhandledCount: 0,
    storage: { totalBytes: 0, latestVersionBytes: 0 },
  },
];
const projects = [
  { id: "project_signal", name: "Signal", remoteUrl: null, createdAt: artifactFixture.createdAt },
  { id: "project_atlas", name: "Atlas", remoteUrl: null, createdAt: artifactFixture.createdAt },
];
const data = [
  [["artifacts"], artifacts],
  [["artifact-projects"], projects],
];
const meta = {
  title: "Pages/ArtifactHome",
  component: ArtifactHome,
  args: { initialSearch: "" },
  decorators: [
    (Story, context) => (
      <div
        className="bg-neutral-50 dark:bg-neutral-900"
        style={{ height: context.parameters.libraryHeight ?? 780 }}
      >
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "fullscreen", queryData: data },
} satisfies Meta<typeof ArtifactHome>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("img", { name: "Files artifact" })).toHaveLength(3);
    await expect(canvas.getAllByText("1 to review")).toHaveLength(2);
    await expect(canvas.getByText("3.5 MB stored")).toBeVisible();
    await expect(canvas.getByRole("combobox", { name: "Artifact kind" })).toBeVisible();
  },
};
export const Dark: Story = { ...Default, globals: { theme: "dark" } };
export const WideDesktop: Story = {
  ...Default,
  parameters: {
    viewport: {
      viewports: {
        wide: { name: "Wide desktop", styles: { width: "1920px", height: "1080px" } },
      },
      defaultViewport: "wide",
    },
  },
};
export const Phone: Story = { ...Default, parameters: phoneViewport() };
export const Filter: Story = {
  parameters: { libraryHeight: 420 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Archived 1/ }));
    await expect(canvas.getByRole("link", { name: /Stored code changes/ })).toBeVisible();
    await expect(canvas.queryByRole("link", { name: /Interactive prototype/ })).toBeNull();
    await userEvent.selectOptions(canvas.getByRole("combobox", { name: "Artifact kind" }), "html");
    await expect(canvas.getByText("No artifacts found")).toBeVisible();
  },
};
const search: ArtifactSearchResponse = {
  artifacts: [artifacts[0], artifacts[1]],
  total: 2,
  counts: { all: 2, content: 1, conversation: 1 },
  nextOffset: null,
  skippedFiles: 0,
  matches: [
    {
      id: "match_historical",
      artifactId: "artifact_files",
      category: "content",
      versionSeq: 2,
      path: "design.md",
      feedbackId: null,
      replyId: null,
      context: { versionSeq: 2, representation: "source" },
      target: {
        kind: "source",
        versionSeq: 2,
        path: "design.md",
        locator: { start: 28, end: 28, quote: "Keyboard focus needs a visible outline." },
      },
      snippet: "Keyboard focus needs a visible outline.",
    },
    {
      id: "match_reply",
      artifactId: "artifact_html",
      category: "reply",
      versionSeq: 4,
      path: null,
      feedbackId: "feedback_keyboard",
      replyId: "reply_keyboard",
      context: { versionSeq: 4, representation: "rendered" },
      target: null,
      snippet:
        "Added keyboard focus indicators to the onboarding actions. Please review version 4.",
    },
  ],
};
const searchQuery = "?q=keyboard&history=all";
export const Search: Story = {
  args: { initialSearch: searchQuery },
  parameters: {
    queryData: [
      ...data,
      [["artifact-search", librarySearchOptions(readLibraryState(searchQuery))], search],
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const link = canvas.getByRole("link", { name: /Published documents/ });
    await expect(link).toHaveAttribute("href", expect.stringContaining("version=2"));
    await expect(link).toHaveAttribute("href", expect.stringContaining("line=28"));
    await expect(canvas.getByText("Historical")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Conversations 1" })).toBeVisible();
  },
};
export const SearchDark: Story = { ...Search, globals: { theme: "dark" } };
export const SearchFocused: Story = {
  ...Search,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole("searchbox"));
  },
};
export const SearchFocusedDark: Story = { ...SearchFocused, globals: { theme: "dark" } };
export const SearchPhone: Story = {
  ...Search,
  parameters: { ...Search.parameters, ...phoneViewport() },
};
export const Empty: Story = {
  parameters: {
    queryData: [
      [["artifacts"], []],
      [["artifact-projects"], []],
    ],
  },
};
export const NoMatches: Story = {
  args: { initialSearch: searchQuery },
  parameters: {
    queryData: [
      ...data,
      [
        ["artifact-search", librarySearchOptions(readLibraryState(searchQuery))],
        { ...search, matches: [], total: 0, counts: { all: 0, content: 0, conversation: 0 } },
      ],
    ],
  },
};
