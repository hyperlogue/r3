import type { Meta, StoryObj } from "@storybook/react-vite";
import { artifactFixture } from "../artifact-fixtures.ts";
import { ArtifactComposer } from "./ArtifactComposer.tsx";
import { ArtifactHeader } from "./ArtifactHeader.tsx";
import { ArtifactThreads } from "./ArtifactThreads.tsx";
import { FileBrowser } from "./FileBrowser.tsx";
import { Login } from "./Login.tsx";

const meta = {
  title: "Design/Containers",
  parameters: { queryData: [[["artifact-watchers", artifactFixture.id], []]] },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Layers: Story = {
  render: () => (
    <div className="space-y-6">
      <ArtifactHeader detail={artifactFixture} />
      <div className="flex flex-wrap items-start gap-8">
        <div className="h-[480px] w-96 border border-neutral-300 dark:border-neutral-700">
          <ArtifactThreads
            detail={artifactFixture}
            context={{ versionSeq: 1, representation: "rendered" }}
            onLocate={() => {}}
            onJumpRef={() => {}}
            keysActive={false}
          />
        </div>
        <div className="r3-floating h-[480px] w-96 overflow-hidden rounded-lg border border-neutral-300 dark:border-neutral-700">
          <ArtifactThreads
            detail={artifactFixture}
            context={{ versionSeq: 1, representation: "rendered" }}
            onLocate={() => {}}
            onJumpRef={() => {}}
            keysActive={false}
          />
        </div>
        <div className="r3-floating w-96 overflow-hidden rounded-lg border border-neutral-300 dark:border-neutral-700">
          <ArtifactComposer
            artifactId="artifact_container_sample"
            replyTo="feedback_container_sample"
          />
        </div>
      </div>
      <div className="flex h-64 border border-neutral-300 dark:border-neutral-700">
        <FileBrowser
          files={["index.html", "styles.css"]}
          viewed={new Set()}
          activePath="index.html"
          onSelect={() => {}}
        />
      </div>
    </div>
  ),
};
export const DarkLayers: Story = { ...Layers, globals: { theme: "dark" } };
export const LoginContainer: Story = {
  render: () => (
    <div className="h-[600px]">
      <Login />
    </div>
  ),
};
