import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { getSyntaxTheme } from "../settings.ts";
import { renderedCode, renderedMarkdown } from "./_fixtures.ts";
import { FileView } from "./FileView.tsx";

const REVIEW_ID = "review_remote";
const REF = "WORKING";
// FileView's blob query key includes the active syntax theme; read the live
// value so the seed key matches what the component will look up.
const theme = getSyntaxTheme();

const meta = {
  title: "Components/FileView",
  component: FileView,
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-3xl">
        <Story />
      </div>
    ),
  ],
  args: {
    reviewId: REVIEW_ID,
    refName: REF,
    viewed: false,
    toggle: fn(),
    onSha: fn(),
    onPickLines: fn(),
  },
} satisfies Meta<typeof FileView>;

export default meta;
type Story = StoryObj<typeof meta>;

// A syntax-highlighted code file. Click/drag the gutter to anchor feedback.
export const Code: Story = {
  args: { path: renderedCode.path },
  parameters: {
    queryData: [[["blob", REVIEW_ID, renderedCode.path, REF, theme], renderedCode]],
  },
};

// A markdown file renders HTML by default; the header toggle switches to the
// (line-anchorable) raw source.
export const Markdown: Story = {
  args: { path: renderedMarkdown.path },
  parameters: {
    queryData: [[["blob", REVIEW_ID, renderedMarkdown.path, REF, theme], renderedMarkdown]],
  },
};

// Marked viewed → folded to just the header. `viewed` is the boolean the parent
// computes (from the loaded content sha); here it's forced on.
export const Viewed: Story = {
  args: { path: renderedCode.path, viewed: true },
  parameters: {
    queryData: [[["blob", REVIEW_ID, renderedCode.path, REF, theme], renderedCode]],
  },
};
