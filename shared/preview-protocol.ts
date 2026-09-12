import type { ArtifactFeedback, ArtifactNotification, RenderedLocator } from "./artifacts.ts";

export interface PreviewBootstrap {
  contextId: string;
  applicationOrigin: string;
  artifactId: string;
  versionSeq: number;
  entryPath: string;
  resourceRoot: string;
  presentation: "document" | "media";
}

export interface PreviewPageContext {
  artifactId: string;
  versionSeq: number;
  path: string;
  resourceRoot: string;
  representation: "rendered" | "source";
  state: "active" | "archived";
}

export interface PreviewDisplay {
  commenting: boolean;
  targets: { feedbackId: string; locator: RenderedLocator | null }[];
  jump: { locator: RenderedLocator | null; nonce: number } | null;
}

// These are the entire publisher-page capability surface. There is no generic
// HTTP, actor, version, path, lifecycle, publication, or host command argument.
export interface ArtifactUtility {
  getContext(): Promise<PreviewPageContext>;
  getThreads(): Promise<ArtifactFeedback[]>;
  createFeedback(input: {
    body: string;
    locator?: RenderedLocator | null;
  }): Promise<ArtifactFeedback>;
  reply(input: { feedbackId: string; body: string }): Promise<unknown>;
  submit(): Promise<{ notification: ArtifactNotification }>;
  subscribe(listener: () => void): () => void;
}
