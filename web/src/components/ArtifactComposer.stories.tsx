import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { artifactDrafts } from "../artifact-drafts.ts";
import { ArtifactComposer } from "./ArtifactComposer.tsx";

const meta = {
  title: "Components/ArtifactComposer",
  component: ArtifactComposer,
  args: { artifactId: "artifact_composer_story" },
  decorators: [
    (Story) => (
      <div className="max-w-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ArtifactComposer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const General: Story = { args: { artifactId: "artifact_general_composer" } };
export const GeneralDark: Story = { ...General, globals: { theme: "dark" } };
export const KeepDraftOnEscape: Story = {
  args: { artifactId: "artifact_persisted_composer" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const textbox = canvas.getByRole("textbox", { name: "Feedback" });
    await userEvent.type(textbox, "Keep this draft");
    await userEvent.keyboard("{Escape}");
    await expect(textbox).toHaveValue("Keep this draft");
  },
};
export const RenderedTarget: Story = {
  loaders: [
    () => {
      artifactDrafts.anchor("artifact_composer_story", {
        kind: "rendered",
        versionSeq: 1,
        path: "index.md",
        locator: { selector: "a", quote: "View the comparison" },
      });
      return {};
    },
  ],
};
export const VersionedReply: Story = {
  args: { artifactId: "artifact_reply_story", replyTo: "feedback_story" },
  loaders: [
    () => {
      artifactDrafts.beginReply("artifact_reply_story", "feedback_story", {
        versionSeq: 3,
        representation: "source",
      });
      return {};
    },
  ],
};
export const RetiredDescriptionDraft: Story = {
  args: { artifactId: "artifact_description_draft" },
  loaders: [
    () => {
      artifactDrafts.anchor("artifact_description_draft", {
        kind: "version_summary",
        versionSeq: 1,
        locator: { quote: "Original description" },
      });
      artifactDrafts.update("artifact_description_draft", { body: "Keep this saved feedback" });
      return {};
    },
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Add feedback" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("button", { name: "Clear target" }));
    await expect(canvas.getByRole("textbox", { name: "Feedback" })).toHaveValue(
      "Keep this saved feedback",
    );
    await expect(canvas.getByRole("button", { name: "Add feedback" })).toBeEnabled();
  },
};

export const Floating: Story = {
  ...RenderedTarget,
  args: { floating: { left: 360, top: 140, bottom: 164, onClose: () => {} } },
};
export const FloatingDark: Story = { ...Floating, globals: { theme: "dark" } };
