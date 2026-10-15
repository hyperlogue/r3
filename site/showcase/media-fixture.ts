import type {
  ArtifactDetail,
  ArtifactMediaTarget,
  ArtifactVersion,
} from "../../shared/artifacts.ts";
import type { ArtifactAttachment } from "../../shared/attachments.ts";
import type { ArtifactDemoSeed, DemoPublication } from "../../web/demo/artifact-model.ts";
import { demoStorageUsage } from "../../web/demo/artifact-model.ts";
import { artifactFixture, artifactFixtureThread } from "../../web/src/artifact-fixtures.ts";

export interface MediaAsset {
  base64: string;
  hash: string;
  byteLength: number;
}
declare const MEDIA_EXAMPLE: Record<string, MediaAsset>;
export const MEDIA_ID = "artifact_example_launch";
const actor = { role: "agent" as const, sessionId: "demo-agent" };
const date = "2026-10-15T12:00:00.000Z";
const box = { x: 0.065, y: 0.76, width: 0.44, height: 0.14 };
const asset = (name: string, version: number, extension = "png") =>
  MEDIA_EXAMPLE[`fieldwork-launch${name}-v${version}.${extension}`]!;

function frame(version: number, video: boolean): ArtifactAttachment {
  const bytes = asset(video ? "-frame" : "", version);
  return {
    id: `image_launch_${video ? "video" : "image"}_${version}`,
    artifactId: MEDIA_ID,
    hash: bytes.hash,
    byteLength: bytes.byteLength,
    mediaType: "image/png",
    width: 960,
    height: 540,
  };
}

export function mediaFrames() {
  return [1, 2].flatMap((version) =>
    [false, true].map((video) => {
      const metadata = frame(version, video);
      const bytes = asset(video ? "-frame" : "", version);
      return [
        metadata.id,
        {
          artifactId: MEDIA_ID,
          blob: new Blob([Uint8Array.from(atob(bytes.base64), (value) => value.charCodeAt(0))], {
            type: "image/png",
          }),
        },
      ] as const;
    }),
  );
}

export function mediaSeed(
  palette: Pick<ArtifactDemoSeed, "themes" | "themeStyles">,
  videoScene = false,
): ArtifactDemoSeed {
  const versions: ArtifactVersion[] = [1, 2].map((seq) => ({
    artifactId: MEDIA_ID,
    seq,
    publicationKey: `launch-${seq}`,
    contentHash: `launch-content-${seq}`,
    label: seq === 1 ? "Launch campaign" : "Clearer date, longer hold",
    summary:
      seq === 1
        ? "Announcement artwork and a six-second title clip."
        : "A darker date label and an eight-second title clip.",
    publishedBy: actor,
    provenance: {},
    createdAt: date,
    publishedAt: date,
    kind: "files",
    entrypoint: null,
    fileCount: 2,
  }));
  const target = (version: number, video: boolean): ArtifactMediaTarget => ({
    kind: "media",
    versionSeq: version,
    path: video ? "launch.webm" : "launch.png",
    locator: { time: video ? 2 : null, box, frame: frame(version, video) },
  });
  const detail: ArtifactDetail = {
    ...structuredClone(artifactFixture),
    id: MEDIA_ID,
    title: "Example Fieldwork · Launch campaign",
    createdBy: actor,
    nextSeq: 3,
    watching: true,
    agentLabels: { "demo-agent": "Example agent" },
    versions,
    threads: [videoScene].map((video) => {
      const kind = video ? "video" : "image";
      const threadId = `thread_launch_${kind}`;
      return {
        ...structuredClone(artifactFixtureThread),
        id: threadId,
        artifactId: MEDIA_ID,
        target: target(1, video),
        comments: [
          {
            ...artifactFixtureThread.comments[0]!,
            id: `comment_launch_${kind}_question`,
            threadId,
            artifactId: MEDIA_ID,
            body: video
              ? "Use a darker date label and hold this frame longer."
              : "The launch date is easy to miss. Give it more contrast.",
            context: { versionSeq: 1, representation: "media" as const },
          },
          {
            ...artifactFixtureThread.comments[1]!,
            id: `comment_launch_${kind}_fix`,
            threadId,
            artifactId: MEDIA_ID,
            author: actor,
            body: video
              ? "Added a dark label and held the title for two more seconds."
              : "Placed the date on a dark green label. The headline stays the focus.",
            context: { versionSeq: 2, representation: "media" as const },
            target: target(2, video),
          },
        ],
      };
    }),
  };
  const publications = Object.fromEntries(
    versions.map((version) => {
      const files = [false, true].map((video) => {
        const bytes = asset("", version.seq, video ? "webm" : "png");
        return {
          path: video ? "launch.webm" : "launch.png",
          hash: bytes.hash,
          byteLength: bytes.byteLength,
          mediaType: video ? "video/webm" : "image/png",
          renderedHash: null,
          rendererRevision: null,
        };
      });
      const publication: DemoPublication = {
        version,
        files,
        sources: {},
        resources: {
          "launch.png": asset("", version.seq).base64,
          "launch.webm": asset("", version.seq, "webm").base64,
        },
        diff: [],
        fullDiff: [],
        patchBytes: 0,
        storageBlobs: Object.fromEntries(files.map((file) => [file.hash, file.byteLength])),
      };
      return [`${MEDIA_ID}/${version.seq}`, publication];
    }),
  );
  detail.storage = demoStorageUsage(Object.values(publications));
  return {
    artifacts: [detail],
    projects: [],
    publications,
    pending: {},
    themes: palette.themes,
    themeStyles: palette.themeStyles,
  };
}
