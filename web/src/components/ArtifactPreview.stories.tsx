import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import type { ArtifactVersion } from "../../../shared/artifacts.ts";
import { artifactApi } from "../artifact-api.ts";
import { artifactFixture, artifactFixtureVersion } from "../artifact-fixtures.ts";
import { markdownCache } from "../markdown-cache.ts";
import { previewSessions } from "../preview-sessions.ts";
import { AppHeader } from "./AppHeader.tsx";
import { ArtifactPreview } from "./ArtifactPreview.tsx";
import {
  ArtifactPreviewSecurity,
  ArtifactPreviewSecurityProvider,
} from "./ArtifactPreviewSecurity.tsx";

const meta = {
  title: "Components/ArtifactPreview",
  component: ArtifactPreview,
  args: {
    detail: artifactFixture,
    version: artifactFixtureVersion as ArtifactVersion,
    path: "index.md",
    commenting: false,
    jump: null,
    targets: [],
    onTarget: () => {},
    onDocument: () => {},
    onFeedback: () => {},
  },
  decorators: [
    (Story) => (
      <ArtifactPreviewSecurityProvider>
        <AppHeader>
          <div className="flex-1" />
          <ArtifactPreviewSecurity />
        </AppHeader>
        <Story />
      </ArtifactPreviewSecurityProvider>
    ),
  ],
  parameters: {
    queryData: [
      [
        ["artifact-files", artifactFixture.id, artifactFixtureVersion.seq],
        [{ path: "index.md", mediaType: "text/markdown", renderedHash: "retained" }],
      ],
    ],
  },
  beforeEach: () => {
    previewSessions.forget(artifactFixture.id);
    const original = artifactApi.createPreview;
    artifactApi.createPreview = async () => {
      throw new Error("Rendered previews are not configured on this server");
    };
    return () => {
      artifactApi.createPreview = original;
    };
  },
} satisfies Meta<typeof ArtifactPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unavailable: Story = {};
export const RetryUnavailable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText("Rendered previews are not configured on this server"),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Retry preview" }));
    await expect(
      await canvas.findByText("Rendered previews are not configured on this server"),
    ).toBeVisible();
  },
};
// Presentation only; the real sandbox and browser gate run in acceptance tests.
export const VerificationFailure: Story = {
  beforeEach: () => {
    const original = artifactApi.createPreview;
    artifactApi.createPreview = async () => {
      throw new Error(
        "Could not verify preview isolation. Retry when the preview server is reachable.",
      );
    };
    return () => {
      artifactApi.createPreview = original;
    };
  },
};
export const Opening: Story = {
  beforeEach: () => {
    const original = artifactApi.createPreview;
    artifactApi.createPreview = () => new Promise(() => {});
    return () => {
      artifactApi.createPreview = original;
    };
  },
};
export const OpeningDark: Story = { ...Opening, globals: { theme: "dark" } };
export const FileMarkdownOpening: Story = {
  ...Opening,
  args: { detail: { ...artifactFixture, kind: "files" } },
};

const cachedHtml =
  '<!doctype html><style>body{margin:0;padding:32px;font:16px/1.65 system-ui}main{max-width:900px;margin:auto}a{color:#86b5ff}pre{padding:16px;background:#8882}</style><main><h1>Already opened Markdown</h1><p>This document can be read while the preview checks run.</p><p><a href="page.md">Document links</a> and feedback become available when the checks finish.</p><pre><code>const version = 1;</code></pre></main>';
const cachedFile = {
  path: "index.md",
  mediaType: "text/markdown",
  renderedHash: "",
  rendererRevision: "story-1",
};
export const CachedMarkdownOpening: Story = {
  ...FileMarkdownOpening,
  parameters: {
    queryData: [[["artifact-files", artifactFixture.id, artifactFixtureVersion.seq], [cachedFile]]],
  },
  beforeEach: async () => {
    cachedFile.renderedHash = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(cachedHtml))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    await markdownCache.load(
      { artifactId: artifactFixture.id, versionSeq: artifactFixtureVersion.seq, ...cachedFile },
      async () => cachedHtml,
    );
    const original = artifactApi.createPreview;
    artifactApi.createPreview = () => new Promise(() => {});
    return () => {
      artifactApi.createPreview = original;
      void markdownCache.forget(artifactFixture.id);
    };
  },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByTitle("Cached Markdown — preview checks in progress"),
    ).toBeVisible();
  },
};
export const CachedMarkdownOpeningDark: Story = {
  ...CachedMarkdownOpening,
  globals: { theme: "dark" },
};

export const HtmlProtection: Story = {
  args: {
    detail: { ...artifactFixture, kind: "html" },
    version: { ...artifactFixtureVersion, kind: "html", entrypoint: "index.md", fileCount: 1 },
  },
};

export const HtmlConsent: Story = {
  ...HtmlProtection,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /^Preview security:/ }));
    await userEvent.click(canvas.getByRole("button", { name: "Allow external access" }));
    await expect(canvas.getByRole("dialog")).toBeVisible();
  },
};

export const HtmlExternalConnections: Story = {
  ...HtmlProtection,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /^Preview security:/ }));
    await userEvent.click(canvas.getByRole("button", { name: "Allow external access" }));
    await userEvent.click(
      within(canvas.getByRole("dialog")).getByRole("button", {
        name: "Allow external access",
      }),
    );
    await expect(canvas.getByRole("button", { name: "Restore protection" })).toBeVisible();
  },
};
