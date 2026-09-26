import type {
  ArtifactDetail,
  ArtifactFile,
  ArtifactProject,
  ArtifactSource,
  ArtifactStorageUsage,
  ArtifactVersion,
} from "../../shared/artifacts.ts";
import type { DiffFileChange, ThemeOption, ThemeStyle } from "../../shared/types.ts";

// Presentation payloads are baked by the generator. The public entities remain
// exactly the daemon contract; this only describes the demo's storage.
export interface DemoPublication {
  version: ArtifactVersion;
  files: ArtifactFile[];
  sources: Record<string, ArtifactSource>;
  resources: Record<string, string>;
  diff: DiffFileChange[];
  fullDiff: DiffFileChange[];
  storageBlobs: Record<string, number>;
  patchBytes: number;
}
export interface ArtifactDemoSeed {
  artifacts: ArtifactDetail[];
  projects: ArtifactProject[];
  publications: Record<string, DemoPublication>;
  pending: Record<string, DemoPublication>;
  themes: ThemeOption[];
  themeStyles: Record<string, ThemeStyle>;
}
export interface ArtifactDemoState extends ArtifactDemoSeed {
  schema: number;
  viewed: Record<string, string[]>;
  feedbackRevisions: Record<string, number>;
  everDelivered: Record<string, boolean>;
}
export const publicationKey = (id: string, seq: number) => `${id}/${seq}`;

export function demoStorageUsage(publications: DemoPublication[]): ArtifactStorageUsage {
  const blobs = Object.assign({}, ...publications.map((item) => item.storageBlobs));
  const latest = publications.at(-1);
  const sum = (sizes: Record<string, number>) => Object.values(sizes).reduce((a, b) => a + b, 0);
  return {
    totalBytes: sum(blobs) + publications.reduce((total, item) => total + item.patchBytes, 0),
    latestVersionBytes: latest ? sum(latest.storageBlobs) + latest.patchBytes : 0,
  };
}
