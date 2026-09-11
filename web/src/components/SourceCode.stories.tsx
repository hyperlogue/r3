import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { SourceCode } from "./SourceCode.tsx";

const meta = {
  title: "Components/SourceCode",
  component: SourceCode,
  args: {
    path: "index.html",
    data: {
      lines: [
        {
          lineNo: 1,
          text: "<h1>Published source</h1>",
          html: "&lt;h1&gt;Published source&lt;/h1&gt;",
        },
        { lineNo: 2, text: "", html: "" },
        {
          lineNo: 3,
          text: "<p>Source and rendered targets are independent.</p>",
          html: "&lt;p&gt;Source and rendered targets are independent.&lt;/p&gt;",
        },
      ],
    },
    regions: [],
    onPickLines: fn(),
  },
  decorators: [
    (Story) => (
      <div className="h-72 overflow-auto border border-neutral-300" data-file="index.html">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SourceCode>;
export default meta;
type Story = StoryObj<typeof meta>;
export const PublishedHtmlSource: Story = {};
export const LongFile: Story = {
  args: {
    data: {
      lines: Array.from({ length: 2000 }, (_, i) => ({
        lineNo: i + 1,
        text: `Published line ${i + 1}`,
        html: `Published line ${i + 1}`,
      })),
    },
  },
};
