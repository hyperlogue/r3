import type { Meta, StoryObj } from "@storybook/react";
import type { AuthTokenInfo } from "../types.ts";
import { TokenManager } from "./TokenManager.tsx";

const tokens: AuthTokenInfo[] = [
  {
    id: "authtok_ab12cd",
    label: "laptop",
    createdAt: "2026-07-10T12:00:00Z",
    lastUsedAt: "2026-07-12T09:30:00Z",
    current: true, // the caller's own session token — revoke is disabled
  },
  {
    id: "authtok_ef34gh",
    label: "phone",
    createdAt: "2026-07-11T08:00:00Z",
    lastUsedAt: null,
  },
];

// The login-token panel embedded in the settings popup. Network is disabled in the
// workshop, so the list is seeded via queryData; create/revoke fire real fetches
// (not exercised here).
const meta = {
  title: "Components/TokenManager",
  component: TokenManager,
  decorators: [
    (Story) => (
      <div className="w-64 rounded-lg border border-neutral-300 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-950">
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "padded", queryData: [[["auth-tokens"], tokens]] },
} satisfies Meta<typeof TokenManager>;

export default meta;
type Story = StoryObj<typeof meta>;

// The create form + two live tokens: the caller's own session token (revoke disabled,
// "this session") and a second, never-used one that can be revoked.
export const WithTokens: Story = {};

// No tokens yet — just the create form.
export const Empty: Story = {
  parameters: { queryData: [[["auth-tokens"], []]] },
};
