import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { artifactApi as demoApi } from "../../demo/artifact-api.ts";
import { artifactApi } from "../artifact-api.ts";
import { FeedbackCardGallery, seedFeedbackCardGallery } from "./FeedbackCardGallery.tsx";

const meta = {
  title: "Showcase/FeedbackCardGallery",
  component: FeedbackCardGallery,
  args: { announce: fn() },
  beforeEach: () => {
    const original = { ...artifactApi };
    Object.assign(artifactApi, demoApi);
    seedFeedbackCardGallery();
    return () => Object.assign(artifactApi, original);
  },
} satisfies Meta<typeof FeedbackCardGallery>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Examples: Story = {};
export const Dark: Story = { globals: { theme: "dark" } };
export const ExpandConversation: Story = {
  play: async ({ canvasElement }) => {
    const history = within(
      canvasElement.querySelector('[data-card-example="history"]')! as HTMLElement,
    );
    await userEvent.click(history.getByRole("button", { name: "4 earlier replies" }));
    await expect(history.getByText("How many replies would remain visible?")).toBeVisible();
    const quote = within(
      canvasElement.querySelector('[data-card-example="rendered"]')! as HTMLElement,
    );
    await userEvent.click(quote.getByRole("button", { name: "Expand quote" }));
    await expect(quote.getByRole("button", { name: "Collapse quote" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  },
};
