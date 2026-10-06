import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { type ArtifactUsage, usagePeriods } from "../../../shared/artifact-usage.ts";
import { ArtifactUsagePopup } from "./ArtifactUsagePopup.tsx";

export const usageFixture: ArtifactUsage = {
  asOf: "2026-10-05T16:00:00.000Z",
  timezone: "America/New_York",
  window: "daily",
  completeSince: "2026-09-28T12:00:00.000Z",
  artifacts: { total: 42, active: 30, archived: 12, files: 22, html: 12, diff: 8 },
  versions: 128,
  conversations: { open: 18, resolved: 63, replies: 204 },
  contentBytes: 18_400_000,
  gc: { ttlDays: 30, eligibleArtifacts: 4, reclaimableBytes: 2_600_000 },
  periods: usagePeriods(
    "2026-10-05T16:00:00.000Z",
    "America/New_York",
    "daily",
    "2026-09-28T12:00:00.000Z",
  ).map((p, i) => ({
    ...p,
    artifactsCreated: i % 3,
    versionsPublished: i % 7,
    threadsAdded: i % 5,
    repliesAdded: i % 9,
    archived: i % 2,
  })),
};
const weekly = {
  ...usageFixture,
  window: "weekly",
  periods: usagePeriods(
    usageFixture.asOf,
    usageFixture.timezone,
    "weekly",
    usageFixture.completeSince,
  ),
};
const meta = {
  title: "Components/ArtifactUsagePopup",
  component: ArtifactUsagePopup,
  decorators: [
    (Story) => (
      <div className="relative flex justify-end">
        <Story />
      </div>
    ),
  ],
  parameters: {
    queryData: [
      [["artifact-usage", "daily"], usageFixture],
      [["artifact-usage", "weekly"], weekly],
    ],
  },
} satisfies Meta<typeof ArtifactUsagePopup>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "Usage statistics" });
    await userEvent.click(trigger);
    await expect(canvas.getByRole("dialog", { name: "Usage statistics" })).toBeVisible();
    await expect(canvas.getByText("Activity · America/New_York", { exact: false })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Last 4 weeks" }));
    await expect(canvas.getByRole("columnheader", { name: "Week of" })).toBeVisible();
  },
};
export const Dark: Story = { ...Open, globals: { theme: "dark" } };
export const KeyboardDismiss: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "Usage statistics" });
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByRole("dialog")).toBeNull();
    await expect(trigger).toHaveFocus();
  },
};
