import type { Meta, StoryObj } from "@storybook/react";
import { fn } from "@storybook/test";
import { phoneViewport } from "../storyViewport.ts";
import { multiRound } from "./_fixtures.ts";
import { RoundSelect, RoundSummary } from "./DiffView.tsx";
import { JumpToFile } from "./JumpToFile.tsx";
import { PaneToolbar, TOOLBAR_BTN } from "./PaneToolbar.tsx";

const FILES = ["server/db.ts", "server/index.ts", "web/src/api.ts", "shared/types.ts"];

// The jump-to-file picker rides in a slot (ReviewView composes it with live
// data); the story hands it static props the same way.
const filePicker = (
  <JumpToFile
    files={FILES}
    viewed={new Set(["server/db.ts"])}
    activePath="server/index.ts"
    onSelect={fn()}
    btnClassName={TOOLBAR_BTN}
  />
);

const meta = {
  title: "Components/PaneToolbar",
  component: PaneToolbar,
  args: {
    hasFiles: true,
    filePicker,
    onJump: fn(),
    onFoldAll: fn(),
  },
  argTypes: {
    filePicker: { control: false },
    right: { control: false },
    summary: { control: false },
  },
} satisfies Meta<typeof PaneToolbar>;

export default meta;
type Story = StoryObj<typeof meta>;

// The file-nav strip alone: prev/next file, fold/unfold all, the jump-to-file
// picker — icon-only, titles carry the words.
export const Default: Story = {};

// A multi-round diff review: the round switcher docks flush-right (self-stretch
// fills the bar's height, the negative margin reaches its right edge).
export const WithRoundSwitcher: Story = {
  args: {
    right: <RoundSelect rounds={multiRound} activeSeq={2} onSelect={fn()} />,
  },
};

// An empty diff round: the file buttons hide but the strip stays, so the round
// switcher remains reachable.
export const EmptyRound: Story = {
  args: {
    hasFiles: false,
    filePicker: undefined,
    right: <RoundSelect rounds={multiRound} activeSeq={2} onSelect={fn()} />,
  },
};

// The phone tier: the bar wraps into stacked full-width rows — the round
// switcher first, then the round summary (ReviewView passes it only below md),
// then the buttons left-aligned.
export const Mobile: Story = {
  args: {
    right: <RoundSelect rounds={multiRound} activeSeq={2} onSelect={fn()} />,
    summary: <RoundSummary round={multiRound[1]} onAnchorSummary={fn()} onJumpRef={fn()} />,
  },
  parameters: phoneViewport(),
};
