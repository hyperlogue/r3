import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
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
export const CardLabels: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("General artifact feedback", { exact: true })).toBeNull();
    await expect(canvas.queryByText("You", { exact: true })).toBeNull();
    const agent = canvasElement.querySelector(
      '[data-card-example="agent"] [data-message-author="agent"]',
    )!;
    await expect(within(agent as HTMLElement).getByText("Agent · sample-agent")).toBeVisible();
    const latest = within(
      canvasElement.querySelector('[data-card-example="attention"]')! as HTMLElement,
    );
    await expect(latest.getByRole("button", { name: "index.md" })).toBeVisible();
    const older = within(canvasElement.querySelector('[data-card-example="sent"]')! as HTMLElement);
    await expect(older.getByRole("button", { name: "Version 1 · index.md:8-8" })).toBeVisible();
    const resolve = older.getByRole("button", { name: "✓ Resolve" });
    const style = getComputedStyle(resolve);
    await expect(style.borderTopColor).toBe(style.color);
    await expect(style.borderTopWidth).toBe("1px");
    await userEvent.click(older.getByRole("button", { name: "More actions" }));
    await expect(older.getByRole("dialog", { name: "Feedback actions" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect(older.getByRole("button", { name: "More actions" })).toHaveFocus();
  },
};
export const CardLabelsDark: Story = { ...CardLabels, globals: { theme: "dark" } };
export const QuoteOverflow: Story = {
  play: async ({ canvasElement }) => {
    const sample = canvasElement.querySelector('[data-card-example="sent"]')! as HTMLElement;
    const card = within(sample);
    sample.style.width = "500px";
    await waitFor(() => expect(card.queryByRole("button", { name: "Expand quote" })).toBeNull());
    sample.style.width = "120px";
    await userEvent.click(await card.findByRole("button", { name: "Expand quote" }));
    await expect(card.getByRole("button", { name: "Collapse quote" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    sample.style.width = "500px";
    await waitFor(() => expect(card.queryByRole("button", { name: "Collapse quote" })).toBeNull());
    sample.style.width = "120px";
    await userEvent.click(await card.findByRole("button", { name: "Collapse quote" }));
    await expect(card.getByRole("button", { name: "Expand quote" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    sample.style.width = "";
  },
};
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
