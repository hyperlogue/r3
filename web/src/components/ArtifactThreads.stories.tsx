import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { ArtifactFeedback, ArtifactReply } from "../../../shared/artifacts.ts";
import { artifactApi } from "../artifact-api.ts";
import { artifactDrafts } from "../artifact-drafts.ts";
import { artifactFixture, artifactFixtureFeedback } from "../artifact-fixtures.ts";
import { Button } from "../ui.tsx";
import { ArtifactThreads } from "./ArtifactThreads.tsx";
import { FeedbackPanelControls } from "./FeedbackPanelControls.tsx";

const meta = {
  title: "Components/ArtifactThreads",
  component: ArtifactThreads,
  beforeEach: () => {
    localStorage.removeItem("r3-feedback-notifications");
    window.dispatchEvent(
      new StorageEvent("storage", { key: "r3-feedback-notifications", newValue: null }),
    );
  },
  args: {
    detail: artifactFixture,
    context: { versionSeq: 1, representation: "source" },
    onLocate: fn(),
    onJumpRef: fn(),
    panelControls: <FeedbackPanelControls mode="expanded" onChange={fn()} />,
  },
  parameters: { queryData: [[["artifact-watchers", artifactFixture.id], []]] },
  decorators: [
    (Story) => (
      <div className="h-[720px] max-w-lg border border-neutral-300">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ArtifactThreads>;
export default meta;
type Story = StoryObj<typeof meta>;
export const NativeRenderedThread: Story = {};
export const LatestLabelsFollowPublication: Story = {
  render: (args) => {
    const [detail, setDetail] = useState(args.detail);
    return (
      <>
        <Button
          onClick={() =>
            setDetail({
              ...detail,
              versions: [...args.detail.versions, { ...args.detail.versions[0], seq: 2 }],
            })
          }
        >
          Publish next version
        </Button>
        <ArtifactThreads {...args} detail={detail} />
      </>
    );
  },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const compact = canvas.getByRole("button", { name: "rendered · index.md" });
    await userEvent.click(compact);
    await expect(args.onLocate).toHaveBeenCalledWith(
      artifactFixtureFeedback.target,
      artifactFixtureFeedback.id,
    );
    await userEvent.click(canvas.getByRole("button", { name: "Publish next version" }));
    // The reader is still on v1, but labels must compare with the new publication.
    await expect(
      canvas.getByRole("button", { name: "Version 1 · rendered · index.md" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("button", { name: "rendered · index.md" })).toBeNull();
  },
};

function mockFeedbackCreation(fail = false) {
  const original = { detail: artifactApi.detail, addFeedback: artifactApi.addFeedback };
  let server = structuredClone(artifactFixture);
  artifactApi.detail = async () => server;
  artifactApi.addFeedback = async (artifactId, body, target) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    if (fail) throw new Error("Could not save feedback. Please try again.");
    const note: ArtifactFeedback = {
      ...artifactFixtureFeedback,
      id: crypto.randomUUID(),
      artifactId,
      body,
      target,
      replies: [],
      sentAt: null,
      createdAt: new Date().toISOString(),
    };
    server = { ...server, feedback: [...server.feedback, note] };
    return note;
  };
  return () => Object.assign(artifactApi, original);
}

export const ComposerToCard: Story = {
  beforeEach: () => mockFeedbackCreation(),
  parameters: {
    queryData: [
      [["artifact", artifactFixture.id], artifactFixture],
      [["artifact-watchers", artifactFixture.id], []],
    ],
  },
  render: (args) => {
    const { data = args.detail } = useQuery({
      queryKey: ["artifact", args.detail.id],
      queryFn: () => artifactApi.detail(args.detail.id),
    });
    return <ArtifactThreads {...args} detail={data} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Add general feedback" }));
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Feedback" }),
      "Keep this new note at the top.",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Add feedback" }));
    await waitFor(() => {
      const first = canvasElement.querySelector("[data-feedback-list] > article");
      expect(first).toHaveTextContent("Keep this new note at the top.");
      expect(canvas.queryByRole("textbox", { name: "Feedback" })).toBeNull();
    });
    await expect(canvasElement.querySelectorAll("[data-feedback-list] > article")).toHaveLength(2);
  },
};
export const ComposerToCardDark: Story = { ...ComposerToCard, globals: { theme: "dark" } };
export const ComposerSaveFailed: Story = {
  ...ComposerToCard,
  beforeEach: () => mockFeedbackCreation(true),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Add general feedback" }));
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Feedback" }),
      "Keep my draft after an error.",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Add feedback" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Could not save feedback");
    await expect(canvas.getByRole("textbox", { name: "Feedback" })).toHaveValue(
      "Keep my draft after an error.",
    );
    await expect(canvasElement.querySelectorAll("[data-feedback-list] > article")).toHaveLength(1);
  },
};

const attentionQueue = {
  ...artifactFixture,
  feedback: [
    {
      ...artifactFixtureFeedback,
      id: "feedback_older",
      body: "The next decision needs attention.",
    },
    {
      ...artifactFixtureFeedback,
      id: "feedback_newer",
      body: "Reply here to advance the attention queue.",
      createdAt: "2026-09-12T00:00:00.000Z",
    },
  ],
};
export const ReplyAdvancesAttention: Story = {
  args: { detail: attentionQueue },
  beforeEach: () => {
    const original = { detail: artifactApi.detail, reply: artifactApi.reply };
    let server = structuredClone(attentionQueue);
    artifactApi.detail = async () => server;
    artifactApi.reply = async (feedbackId, input) => {
      const reply: ArtifactReply = {
        ...artifactFixtureFeedback.replies[0],
        id: "reply_human",
        feedbackId,
        author: { role: "human", sessionId: null },
        body: input.body,
        sentAt: null,
      };
      server = {
        ...server,
        feedback: server.feedback.map((note) =>
          note.id === feedbackId ? { ...note, replies: [...note.replies, reply] } : note,
        ),
      };
      return reply;
    };
    return () => Object.assign(artifactApi, original);
  },
  parameters: {
    queryData: [
      [["artifact", artifactFixture.id], attentionQueue],
      [["artifact-watchers", artifactFixture.id], []],
    ],
  },
  render: ComposerToCard.render,
  play: async ({ canvasElement }) => {
    const first = () => canvasElement.querySelector("[data-feedback-list] > article")!;
    await expect(first()).toHaveTextContent("Reply here to advance");
    await userEvent.click(within(first() as HTMLElement).getByRole("button", { name: "Reply" }));
    await userEvent.type(within(canvasElement).getByRole("textbox", { name: "Reply" }), "Agreed.");
    const form = canvasElement.querySelector<HTMLFormElement>("[data-reply-to]")!;
    await userEvent.click(within(form).getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(first()).toHaveTextContent("The next decision needs attention."));
    await expect(canvasElement.querySelectorAll("[data-feedback-list] > article")).toHaveLength(2);
  },
};
export const MenuKeyboardDismiss: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "More actions" });
    await userEvent.click(trigger);
    await expect(canvas.getByRole("button", { name: "Delete" })).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await expect(canvas.queryByRole("dialog", { name: "Feedback actions" })).toBeNull();
    await expect(trigger).toHaveFocus();
  },
};
export const Dark: Story = { globals: { theme: "dark" } };
export const ResolveHovered: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.hover(within(canvasElement).getByRole("button", { name: "✓ Resolve" }));
  },
};
export const ResolveHoveredDark: Story = { ...ResolveHovered, globals: { theme: "dark" } };
export const ResolveIdle: Story = {
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole("button", { name: "✓ Resolve" });
    await expect(getComputedStyle(button).borderTopColor).toBe("rgba(0, 0, 0, 0)");
    await expect(getComputedStyle(button).backgroundColor).toBe("rgba(0, 0, 0, 0)");
  },
};
export const ResolveIdleDark: Story = { ...ResolveIdle, globals: { theme: "dark" } };
export const ResolvePending: Story = {
  beforeEach: () => {
    const original = artifactApi.editFeedback;
    artifactApi.editFeedback = () => new Promise(() => {});
    return () => {
      artifactApi.editFeedback = original;
    };
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "✓ Resolve" }));
    await expect(canvas.getByRole("tab", { name: "Active 0" })).toBeVisible();
    await userEvent.click(canvas.getByRole("tab", { name: "Resolved 1" }));
    await expect(canvas.getByRole("button", { name: "Reopen" })).toBeDisabled();
  },
};
export const ResolveFailed: Story = {
  beforeEach: () => {
    const original = artifactApi.editFeedback;
    artifactApi.editFeedback = async () => {
      throw new Error("Could not save this decision. Try again.");
    };
    return () => {
      artifactApi.editFeedback = original;
    };
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "✓ Resolve" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "Could not save this decision",
    );
    await expect(canvas.getByRole("tab", { name: "Active 1" })).toBeVisible();
  },
};
export const NarrowPanel: Story = {
  decorators: [
    (Story) => (
      <div className="h-full w-[300px]">
        <Story />
      </div>
    ),
  ],
};
export const FeedbackTabs: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const radius = getComputedStyle(canvas.getByRole("button", { name: "✓ Resolve" })).borderRadius;
    await expect(getComputedStyle(canvas.getByRole("tab", { name: /Active/ })).borderRadius).toBe(
      radius,
    );
    await waitFor(() => {
      const indicator = canvasElement.querySelector("[data-feedback-tab-indicator]");
      expect(indicator && getComputedStyle(indicator).borderRadius).toBe(radius);
    });
    await expect(canvas.getByRole("tab", { name: /Active/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.click(canvas.getByRole("tab", { name: /Resolved/ }));
    await waitFor(() => expect(canvas.getByText("No resolved feedback.")).toBeVisible());
    await userEvent.click(canvas.getByRole("button", { name: "Add general feedback" }));
    await waitFor(() => expect(canvas.getByRole("textbox", { name: "Feedback" })).toBeVisible());
    await userEvent.click(canvas.getByRole("tab", { name: /Active/ }));
    const composer = canvasElement.querySelector("[data-artifact-composer]");
    const list = canvasElement.querySelector("[data-feedback-list]");
    await expect(
      composer && list?.querySelector(":scope > :not([inert])")?.contains(composer),
    ).toBeTruthy();
  },
};

export const QueueDraftAndScroll: Story = {
  beforeEach: () => artifactDrafts.clear(artifactFixture.id),
  args: {
    detail: {
      ...artifactFixture,
      feedback: Array.from({ length: 8 }, (_, index) => ({
        ...artifactFixtureFeedback,
        id: `feedback_queue_${index}`,
        status: index < 4 ? "open" : "resolved",
      })),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Add general feedback" }));
    const draft = canvas.getByRole("textbox", { name: "Feedback" });
    await userEvent.type(draft, "Keep this Active draft.");
    const active = canvasElement.querySelector<HTMLElement>('[data-feedback-queue="active"]')!;
    const resolved = canvasElement.querySelector<HTMLElement>('[data-feedback-queue="resolved"]')!;
    const card = active.querySelector("article");
    active.scrollTop = 100;
    await userEvent.click(canvas.getByRole("tab", { name: "Resolved 4" }));
    await expect(canvas.queryByRole("textbox", { name: "Feedback" })).toBeNull();
    await expect(canvas.getByRole("tabpanel")).toHaveAccessibleName("Resolved 4");
    resolved.scrollTop = 70;
    await userEvent.keyboard("{ArrowLeft}");
    await expect(canvas.getByRole("tabpanel")).toHaveAccessibleName("Active 4");
    await expect(canvas.getByRole("textbox", { name: "Feedback" })).toBe(draft);
    await expect(draft).toHaveValue("Keep this Active draft.");
    await expect(active.querySelector("article")).toBe(card);
    await expect(active.scrollTop).toBe(100);
    await expect(resolved.scrollTop).toBe(70);
  },
};
export const QueueDraftAndScrollDark: Story = {
  ...QueueDraftAndScroll,
  globals: { theme: "dark" },
};
export const ComposerAsCard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Add general feedback" }));
    const input = canvas.getByRole("textbox", { name: "Feedback" });
    await expect(input.closest("[data-feedback-list]")).not.toBeNull();
    await userEvent.type(input, "This draft is a pending feedback card.");
    await expect(canvas.queryByText("Post or discard drafts before sending feedback")).toBeNull();
  },
};
export const ComposerAsCardDark: Story = { ...ComposerAsCard, globals: { theme: "dark" } };
export const AgentWorking: Story = {
  args: {
    detail: {
      ...artifactFixture,
      feedback: [
        {
          ...artifactFixtureFeedback,
          claim: {
            feedbackId: artifactFixtureFeedback.id,
            sessionId: "design-agent",
            claimedAt: "2026-09-11T12:00:00Z",
            renewedAt: "2026-09-11T12:00:00Z",
            expiresAt: "2026-09-11T13:00:00Z",
          },
        },
      ],
    },
  },
};
export const ImportedTarget: Story = {
  args: {
    detail: {
      ...artifactFixture,
      feedback: [
        {
          ...artifactFixtureFeedback,
          target: { kind: "artifact" },
          legacy: {
            source: { file: "notes.md", line_start: 8, line_end: 8, quote: "Original text" },
          },
          replies: [],
        },
      ],
    },
  },
};
export const Archived: Story = {
  args: { detail: { ...artifactFixture, state: "archived", archivedAt: "2026-09-11T13:00:00Z" } },
};

export const CardMotion: Story = {
  render: (args) => {
    const [feedback, setFeedback] = useState(() =>
      [1, 2, 3].map((number) => ({
        ...artifactFixtureFeedback,
        id: `motion_${number}`,
        body: `Sample thread ${number}`,
        replies: [],
      })),
    );
    const [next, setNext] = useState(4);
    return (
      <div className="flex h-full flex-col">
        <div className="flex flex-wrap gap-2 border-b border-neutral-300 p-2 dark:border-neutral-700">
          <Button
            onClick={() => {
              setFeedback((current) => [
                ...current,
                {
                  ...artifactFixtureFeedback,
                  id: `motion_${next}`,
                  body: `Sample thread ${next}`,
                  replies: [],
                },
              ]);
              setNext(next + 1);
            }}
          >
            Insert card
          </Button>
          <Button onClick={() => setFeedback((current) => current.slice(1))}>Remove first</Button>
          <Button
            onClick={() =>
              setFeedback((current) =>
                current.length ? [...current.slice(1), current[0]] : current,
              )
            }
          >
            Reorder
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <ArtifactThreads {...args} detail={{ ...args.detail, feedback }} keysActive={false} />
        </div>
      </div>
    );
  },
};

export const LocateResolvedWithDraft: Story = {
  args: { ...QueueDraftAndScroll.args, activeFeedback: "feedback_queue_4" },
  beforeEach: () => {
    artifactDrafts.update(artifactFixture.id, { body: "A draft from the previous visit." });
    return () => artifactDrafts.clear(artifactFixture.id);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByRole("tab", { name: "Resolved 4" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    await expect(canvas.queryByRole("textbox", { name: "Feedback" })).toBeNull();
    await userEvent.click(canvas.getByRole("tab", { name: "Active 4" }));
    await expect(canvas.getByRole("textbox", { name: "Feedback" })).toHaveValue(
      "A draft from the previous visit.",
    );
  },
};

export const PendingHandoff: Story = {
  args: {
    detail: { ...artifactFixture, feedback: [{ ...artifactFixtureFeedback, sentAt: null }] },
  },
  parameters: {
    queryData: [
      [
        ["artifact-watchers", artifactFixture.id],
        [{ actor: { role: "agent", sessionId: "review-agent" } }],
      ],
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Not sent", { exact: true })).toBeVisible();
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Send to agent · 1" })).toBeEnabled(),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Add general feedback" }));
    await userEvent.type(canvas.getByRole("textbox", { name: "Feedback" }), "Keep this draft");
    await expect(canvas.getByRole("button", { name: "Send to agent · 1" })).toHaveAttribute(
      "title",
      "Post or discard drafts before sending feedback",
    );
    await expect(canvas.getByRole("button", { name: "Send to agent · 1" })).toBeDisabled();
  },
};

export const ReopenDuringExit: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Add general feedback" }));
    await Promise.all(
      canvasElement
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(canvasElement.querySelector("[data-feedback-draft][inert]")).not.toBeNull(),
    );
    await userEvent.click(canvas.getByRole("button", { name: "Add general feedback" }));
    await waitFor(() =>
      expect(
        canvasElement.querySelector("[data-artifact-composer] textarea:not([inert] *)"),
      ).toHaveFocus(),
    );
  },
};

export const SentHandoff: Story = {
  args: PendingHandoff.args,
  parameters: PendingHandoff.parameters,
  beforeEach: () => {
    const original = artifactApi.submit;
    artifactApi.submit = async () => ({ notification: { state: "sent" } });
    return () => {
      artifactApi.submit = original;
    };
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const send = canvas.getByRole("button", { name: "Send to agent · 1" });
    await waitFor(() => expect(send).toBeEnabled());
    await userEvent.click(send);
    await expect(await canvas.findByRole("button", { name: "Sent" })).toBeDisabled();
  },
};
