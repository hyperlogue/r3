import type { Decorator, Meta, StoryObj } from "@storybook/react";
import { useEffect } from "react";
import { repos, reviews } from "../components/_fixtures.ts";
import { clearDraft, setDraftText } from "../drafts.ts";
import { Home } from "./Home.tsx";

// Seed an unsaved draft on a review (for the ✎ badge), cleaned up on unmount so
// it doesn't leak into other stories.
const withDraft = (reviewId: string): Decorator => {
  return (Story) => {
    useEffect(() => {
      setDraftText(reviewId, "half-written note about this review…");
      return () => clearDraft(reviewId);
    }, []);
    return <Story />;
  };
};

const meta = {
  title: "Pages/Home",
  component: Home,
  decorators: [
    (Story) => (
      <div className="h-[720px] bg-neutral-50 dark:bg-neutral-900">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
    // GET /api/reviews + GET /api/repos.
    queryData: [
      [["reviews"], reviews],
      [["repos"], repos],
    ],
  },
} satisfies Meta<typeof Home>;

export default meta;
type Story = StoryObj<typeof meta>;

// The reviews home page: a flat list ranked watching > open > approved >
// abandoned, then most-recent first — the watched fork floats to the top
// (green dot) even though it's the oldest, then the two open reviews by recency,
// then approved, then the abandoned one last. Each row carries its repo
// (minimal-unique-suffix: the two "r3" checkouts disambiguate to code/r3 +
// forks/r3) and branch; `legacy-viewer`'s path is missing → its row shows the
// relink/forget recovery affordance.
export const Default: Story = {};

// A review with an unsaved, browser-only draft → the ✎ badge on its row.
export const WithDraft: Story = {
  decorators: [withDraft("review_files")],
};

// No reviews registered yet — the CLI-create hint.
export const Empty: Story = {
  parameters: {
    queryData: [
      [["reviews"], []],
      [["repos"], []],
    ],
  },
};
