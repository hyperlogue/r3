import type { ReactNode } from "react";
import { libraryReturnRoute } from "../artifact-library.ts";
import { DemoChrome } from "../demo-chrome.tsx";
import { hrefFor, navigate } from "../router.ts";
import { ArtifactUsagePopup } from "./ArtifactUsagePopup.tsx";
import { SettingsPopup } from "./SettingsPopup.tsx";
import { WorkspaceHeader } from "./WorkspaceHeader.tsx";

export function AppHeader({
  children,
  showSettings = true,
  showUsage = false,
  returnRoute = libraryReturnRoute(location.search),
}: {
  children?: ReactNode;
  showSettings?: boolean;
  showUsage?: boolean;
  returnRoute?: string | null;
}) {
  const route = returnRoute ?? "/";
  return (
    <WorkspaceHeader
      homeHref={hrefFor(route)}
      onHome={() => navigate(route)}
      tools={
        <>
          <DemoChrome />
          {(showUsage || showSettings) && (
            <div className="flex items-center gap-2 pr-2 max-md:gap-1">
              {showUsage && <ArtifactUsagePopup />}
              {showSettings && <SettingsPopup />}
            </div>
          )}
        </>
      }
    >
      {children}
    </WorkspaceHeader>
  );
}
