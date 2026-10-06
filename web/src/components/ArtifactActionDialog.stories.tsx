import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArtifactActionDialog } from "./ArtifactActionDialog.tsx";

const meta = {
  title: "Components/ArtifactActionDialog",
  component: ArtifactActionDialog,
  args: {
    action: "delete",
    items: [
      { id: "artifact_a", title: "Published design", state: "active" },
      { id: "artifact_b", title: "Older prototype", state: "archived" },
    ],
    onClose: () => {},
    onDone: () => {},
  },
} satisfies Meta<typeof ArtifactActionDialog>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Delete: Story = {};
export const Archive: Story = { args: { action: "archive" } };
export const Dark: Story = { globals: { theme: "dark" } };
