// Entry for the isolated browser acceptance server, never bundled into r3.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { loadBoot } from "../web/src/api.ts";
import { ApplicationUIProvider, applicationUI } from "../web/src/application-ui.tsx";
import { artifactApi } from "../web/src/artifact-api.ts";
import { useArtifactEvents } from "../web/src/artifact-hooks.ts";
import { ArtifactUIProvider } from "../web/src/artifact-ui-context.tsx";
import { ArtifactView } from "../web/src/pages/ArtifactView.tsx";
import "../web/src/main.css";

await loadBoot();
const [artifact] = await artifactApi.list();
const artifactId =
  location.pathname.match(/^\/(artifact_[\w]+)$/)?.[1] ??
  new URLSearchParams(location.search).get("artifact") ??
  artifact.id;
function Fixture() {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <ApplicationUIProvider>
        <ArtifactUIProvider
          value={{
            ...applicationUI,
            chrome: {
              ...applicationUI.chrome,
              tour: new URLSearchParams(location.search).has("tour")
                ? applicationUI.chrome?.tour
                : undefined,
            },
          }}
        >
          <Workspace />
        </ArtifactUIProvider>
      </ApplicationUIProvider>
    </QueryClientProvider>
  );
}
function Workspace() {
  useArtifactEvents();
  return <ArtifactView artifactId={artifactId} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
