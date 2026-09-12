import type {
  ArtifactDetail,
  ArtifactFile,
  ArtifactProject,
  ArtifactSource,
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
}
export const publicationKey = (id: string, seq: number) => `${id}/${seq}`;
