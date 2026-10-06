import type { Meta, StoryObj } from "@storybook/react-vite";
import { ArtifactGcDialog } from "./ArtifactGcDialog.tsx";

const preview = {
  dryRun: true,
  ttlDays: 30,
  cutoff: "2026-09-05T12:00:00.000Z",
  candidates: [
    { id: "artifact_expired", title: "Archived prototype", archivedAt: "2026-09-01T12:00:00.000Z" },
  ],
  reclaimableBytes: 1200000,
  deletedIds: [],
  skippedIds: [],
  failures: [],
};
const meta = {
  title: "Components/ArtifactGcDialog",
  component: ArtifactGcDialog,
  args: { onClose: () => {} },
  parameters: { queryData: [[["artifact-gc"], preview]] },
} satisfies Meta<typeof ArtifactGcDialog>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Preview: Story = {};
export const Dark: Story = { globals: { theme: "dark" } };
export const Empty: Story = {
  parameters: {
    queryData: [[["artifact-gc"], { ...preview, candidates: [], reclaimableBytes: 0 }]],
  },
};
