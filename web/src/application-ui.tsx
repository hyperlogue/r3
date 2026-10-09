import type { ReactNode } from "react";
import { api } from "./api.ts";
import { artifactApi } from "./artifact-api.ts";
import { libraryReturnRoute } from "./artifact-library.ts";
import { type ArtifactUIEnvironment, ArtifactUIProvider } from "./artifact-ui-context.tsx";
import { AppHeader } from "./components/AppHeader.tsx";
import { SettingsDialog } from "./components/SettingsPopup.tsx";
import { navigate } from "./router.ts";

// The connected application owns the HTTP implementation, router, and settings.
// Standalone ArtifactPage consumers supply their own data and mutation handlers.
export const applicationUI: ArtifactUIEnvironment = {
  client: { ...artifactApi, themeStyle: api.themeStyle },
  chrome: {
    header: (children) => <AppHeader showSettings={false}>{children}</AppHeader>,
    settings: (props) => <SettingsDialog {...props} />,
    onDeleted: () => navigate(libraryReturnRoute(location.search) ?? "/"),
  },
};
export function ApplicationUIProvider({ children }: { children: ReactNode }) {
  return <ArtifactUIProvider value={applicationUI}>{children}</ArtifactUIProvider>;
}
