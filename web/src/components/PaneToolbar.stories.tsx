import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import { phoneViewport } from "../storyViewport.ts";
import { JumpToFile } from "./JumpToFile.tsx";
import { DiffLayoutToggle, PaneToolbar, TOOLBAR_BTN } from "./PaneToolbar.tsx";

const FILES = ["server/db.ts", "server/index.ts", "web/src/api.ts", "shared/types.ts"];

// The jump-to-file picker rides in a slot (ArtifactView composes it with live
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
    layoutToggle: { control: false },
  },
} satisfies Meta<typeof PaneToolbar>;

export default meta;
type Story = StoryObj<typeof meta>;

// The file-nav strip alone: prev/next file, fold/unfold all, the jump-to-file
// picker — icon-only, titles carry the words.
export const Default: Story = {};

export const WithDiffLayout: Story = {
  args: { layoutToggle: <DiffLayoutToggle /> },
};

export const Empty: Story = {
  args: { hasFiles: false, filePicker: undefined },
};

// The same file controls remain on phones; the layout toggle is hidden because
// ArtifactView forces unified diffs below md without changing the saved choice.
export const Mobile: Story = {
  args: { layoutToggle: <DiffLayoutToggle /> },
  parameters: phoneViewport(),
};
