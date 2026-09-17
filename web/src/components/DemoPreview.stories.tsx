import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { expect, waitFor } from "storybook/test";
import type { ArtifactDocumentTarget } from "../../../shared/artifacts.ts";
import { ARTIFACT_DEMO_SEED } from "../../demo/artifact-fixtures.gen.ts";
import { DemoArtifactPreview } from "../../demo/artifact-renderer.tsx";

function PreviewWorkshop({ markdown = false }: { markdown?: boolean }) {
  const detail = ARTIFACT_DEMO_SEED.artifacts.find(
    (item) => item.kind === (markdown ? "files" : "html"),
  )!;
  const [path, setPath] = useState(markdown ? "index.md" : "index.html");
  const [commenting, setCommenting] = useState(false);
  const [target, setTarget] = useState<ArtifactDocumentTarget | null>(null);
  return (
    <div className="flex h-screen flex-col bg-white dark:bg-neutral-950">
      <div className="flex gap-3 border-b border-neutral-300 p-3 dark:border-neutral-700">
        <button type="button" onClick={() => setCommenting(!commenting)}>
          Comment mode: {commenting ? "on" : "off"}
        </button>
        <span>{target?.locator?.quote ?? "Select text or an element in the preview"}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-artifact-content>
        <DemoArtifactPreview
          detail={detail}
          version={detail.versions[0]}
          path={path}
          commenting={commenting}
          targets={[]}
          jump={null}
          onTarget={setTarget}
          onSelection={setTarget}
          onDocument={setPath}
          onFeedback={() => {}}
        />
      </div>
    </div>
  );
}
const meta = {
  title: "Demo/Previews",
  component: PreviewWorkshop,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PreviewWorkshop>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Html: Story = {};
export const Markdown: Story = {
  args: { markdown: true },
  play: async ({ canvasElement }) => {
    await waitFor(() =>
      expect(canvasElement.querySelector('iframe[aria-hidden="false"]')).not.toBeNull(),
    );
    await waitFor(() => expect(canvasElement.querySelector('[aria-busy="true"]')).toBeNull());
  },
};
