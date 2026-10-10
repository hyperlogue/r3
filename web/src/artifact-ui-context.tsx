import { createContext, type ReactNode, type RefObject, useContext } from "react";
import type { api } from "./api.ts";
import type { artifactApi } from "./artifact-api.ts";

// Type-only references keep the HTTP clients out of the reusable UI bundle.
// The same contracts are implemented by the connected app and in-memory hosts.
export type ArtifactPageData = Pick<
  typeof artifactApi,
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
  | "addThread"
  | "editThread"
  | "deleteThread"
  | "comment"
  | "editComment"
  | "submit"
  | "setViewed"
>;
export type ArtifactPageClient = ArtifactPageData & ArtifactPageActions;
export interface ArtifactPageChrome {
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
