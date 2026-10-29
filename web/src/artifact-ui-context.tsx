import { createContext, type ReactNode, type RefObject, useContext } from "react";
import type { ArtifactDetail } from "../../shared/artifacts.ts";
import type { api } from "./api.ts";
import type { artifactApi } from "./artifact-api.ts";

// Type-only references keep the HTTP clients out of the reusable UI bundle.
// The same contracts are implemented by the connected app and in-memory hosts.
export type ArtifactPageData = Pick<
  typeof artifactApi,
  | "anchorResolution"
  | "detail"
  | "files"
  | "source"
  | "diff"
  | "context"
  | "viewed"
  | "watchers"
  | "download"
  | "attachment"
> &
  Pick<typeof api, "themeStyle">;
export type ArtifactPageActions = Pick<
  typeof artifactApi,
  | "edit"
  | "delete"
  | "lifecycle"
  | "bulkArchive"
  | "addThread"
  | "editThread"
  | "deleteThread"
  | "comment"
  | "editComment"
  | "submit"
  | "setViewed"
>;
export type ArtifactPageClient = ArtifactPageData & ArtifactPageActions;
export interface ArtifactTourWorkspace {
  commentModeAvailable: boolean;
  detail: ArtifactDetail;
  root: RefObject<HTMLDivElement | null>;
  ready: boolean;
  revealDiscussion: (visible: boolean) => void;
}
export interface ArtifactPageChrome {
  tour?: (props: ArtifactTourWorkspace) => ReactNode;
  header?: (children: ReactNode) => ReactNode;
  settings?: (props: {
    onClose: () => void;
    trigger: RefObject<HTMLButtonElement | null>;
  }) => ReactNode;
  onDeleted?: () => void;
}
export interface ArtifactUIEnvironment {
  client: ArtifactPageClient;
  chrome?: ArtifactPageChrome;
}
const Environment = createContext<ArtifactUIEnvironment | null>(null);

export function ArtifactUIProvider({
  value,
  children,
}: {
  value: ArtifactUIEnvironment;
  children: ReactNode;
}) {
  return <Environment value={value}>{children}</Environment>;
}
export function useArtifactUI(): ArtifactUIEnvironment {
  const environment = useContext(Environment);
  if (!environment)
    throw new Error("Supply ArtifactPage data and actions, or an ArtifactUIProvider");
  return environment;
}
export const useArtifactClient = () => useArtifactUI().client;
