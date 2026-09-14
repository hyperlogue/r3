import type { ArtifactFeedback, ArtifactNotification, RenderedLocator } from "./artifacts.ts";

export interface PreviewDevicePermissions {
  camera: boolean;
  microphone: boolean;
}

export interface PreviewCaptureState {
  phase: "idle" | "requesting" | "sharing" | "error";
  camera: boolean;
  microphone: boolean;
  message?: string;
}

export interface PreviewBootstrap {
  contextId: string;
  applicationOrigin: string;
  artifactId: string;
  versionSeq: number;
  entryPath: string;
  resourceRoot: string;
  presentation: "document" | "media";
  capture?: boolean;
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
  // r3 appearance for retained Markdown; authored HTML retains its own styling.
  theme?: PreviewTheme;
  // Retained Markdown in file stacks grows with the document's natural height.
  fitContent?: boolean;
  commenting: boolean;
  noteHasText?: boolean;
  composerVisible?: boolean;
  targets: { feedbackId: string; locator: RenderedLocator | null }[];
  jump: { locator: RenderedLocator | null; nonce: number } | null;
}

export interface PreviewViewport {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type PreviewTheme = "light" | "dark";

// These are the entire publisher-page capability surface. There is no generic
// HTTP, actor, version, path, lifecycle, publication, or host command argument.

export interface ArtifactUtility {
  getTheme(): Promise<PreviewTheme | null>;
  setTheme(theme: PreviewTheme): Promise<void>;
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
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
