// Entry for the isolated browser acceptance server, never bundled into r3.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { loadBoot } from "../web/src/api.ts";
import { artifactApi } from "../web/src/artifact-api.ts";
import { useArtifactEvents } from "../web/src/artifact-hooks.ts";
import { ArtifactView } from "../web/src/pages/ArtifactView.tsx";
import "../web/src/main.css";

await loadBoot();
const [artifact] = await artifactApi.list();
function Fixture() {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <Workspace />
    </QueryClientProvider>
  );
}
function Workspace() {
  useArtifactEvents();
  return <ArtifactView artifactId={artifact.id} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
