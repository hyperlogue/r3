import { useEffect } from "react";
import { useArtifactEvents } from "./artifact-hooks.ts";
import { AppHeader } from "./components/AppHeader.tsx";
import { ArtifactHome } from "./pages/ArtifactHome.tsx";
import { ArtifactView } from "./pages/ArtifactView.tsx";
import { useRoute } from "./router.ts";

export function App() {
  const { artifactId } = useRoute();
  useArtifactEvents();

  useEffect(() => {
    if (!artifactId) document.title = "r3";
  }, [artifactId]);

  return (
    <div className="flex h-full flex-col bg-neutral-50 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      {artifactId ? (
        <ArtifactView key={artifactId} artifactId={artifactId} />
      ) : (
        <>
          <AppHeader />
          <main className="min-h-0 flex-1 overflow-hidden">
            <ArtifactHome />
          </main>
        </>
      )}
    </div>
  );
}
