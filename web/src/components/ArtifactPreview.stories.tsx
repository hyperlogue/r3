import type { Meta, StoryObj } from "@storybook/react-vite";
import { artifactApi } from "../artifact-api.ts";
import { artifactFixture, artifactFixtureVersion } from "../artifact-fixtures.ts";
import { ArtifactPreview } from "./ArtifactPreview.tsx";

const meta = {
  title: "Components/ArtifactPreview",
  component: ArtifactPreview,
  args: {
    detail: artifactFixture,
    version: artifactFixtureVersion,
    path: "index.md",
    commenting: false,
    jump: null,
    targets: [],
    onTarget: () => {},
    onDocument: () => {},
    onFeedback: () => {},
  },
  parameters: {
    queryData: [
      [
        ["artifact-files", artifactFixture.id, artifactFixtureVersion.seq],
        [{ path: "index.md", mediaType: "text/markdown", renderedHash: "retained" }],
      ],
    ],
  },
  beforeEach: () => {
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
// Presentation only; the real sandbox and browser gate run in acceptance tests.
export const UnsupportedBrowser: Story = {
  beforeEach: () => {
    const original = artifactApi.createPreview;
    artifactApi.createPreview = async () => {
      throw new Error(
        "This browser cannot enforce r3's preview network policy. Use a browser with Connection Allowlist support.",
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
