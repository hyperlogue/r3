import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { artifactFixture } from "../artifact-fixtures.ts";
import { phoneViewport } from "../storyViewport.ts";
import { ArtifactHome } from "./ArtifactHome.tsx";

const artifacts = [
  {
    ...artifactFixture,
    id: "artifact_files",
    title: "Published documents",
    kind: "files",
    watching: true,
  },
  {
    ...artifactFixture,
    id: "artifact_html",
    title: "Interactive prototype",
    kind: "html",
    storage: { totalBytes: 3_500_000, latestVersionBytes: 1_250_000 },
  },
  {
    ...artifactFixture,
    id: "artifact_diff",
    title: "Stored code changes",
    kind: "diff",
    state: "archived",
  },
];
const meta = {
  title: "Pages/ArtifactHome",
  component: ArtifactHome,
  decorators: [
    (Story) => (
      <div className="h-[680px] bg-neutral-50 dark:bg-neutral-900">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    queryData: [
      [["artifacts"], artifacts],
      [["artifact-projects"], []],
    ],
  },
} satisfies Meta<typeof ArtifactHome>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("Active", { selector: "span" })).toBeNull();
    await expect(canvas.queryByText("design-agent", { exact: true })).toBeNull();
    await expect(canvas.getByRole("img", { name: "Files artifact" })).toBeVisible();
    await expect(canvas.getAllByText("1 unhandled")).toHaveLength(3);
    await expect(canvas.getAllByText("24.6 KB stored")).toHaveLength(2);
    await expect(canvas.getByText("3.5 MB stored")).toBeVisible();
  },
};
export const Dark: Story = { ...Default, globals: { theme: "dark" } };
export const Phone: Story = { ...Default, parameters: phoneViewport() };
export const Filter: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(
      canvas.getByRole("combobox", { name: "Artifact state" }),
      "archived",
    );
    await expect(canvas.getByRole("link", { name: /Stored code changes/ })).toBeInTheDocument();
    await expect(
      canvas.queryByRole("link", { name: /Interactive prototype/ }),
    ).not.toBeInTheDocument();
    await userEvent.type(canvas.getByRole("searchbox"), "missing");
    await expect(canvas.getByText("No artifacts match these filters.")).toBeInTheDocument();
  },
};
export const Empty: Story = {
  parameters: {
    queryData: [
      [["artifacts"], []],
      [["artifact-projects"], []],
    ],
  },
};
