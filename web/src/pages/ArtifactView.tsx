import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { ArtifactApiError } from "../../../shared/artifact-client.ts";
import { artifactWorkspaceSearch } from "../artifact-navigation.ts";
import { ArtifactPage, type ArtifactRenderer } from "../artifact-page.tsx";
import { renderPublishedPreview } from "../artifact-renderer.tsx";
import { readArtifactUpdate } from "../artifact-sync.ts";
import { useArtifactUI } from "../artifact-ui-context.tsx";
import { draftImages } from "../attachment-drafts.ts";
import { AppHeader } from "../components/AppHeader.tsx";
import { ArtifactLoading } from "../components/ArtifactLoading.tsx";
import { markdownCache } from "../markdown-cache.ts";
import { previewSessions } from "../preview-sessions.ts";
import { readingPositions } from "../reading-position.ts";
import { useFaviconBadge } from "../useFaviconBadge.ts";

export type { ArtifactRenderedPaneProps, ArtifactRenderer } from "../artifact-page.tsx";
export { ArtifactWorkspace } from "../artifact-page.tsx";
export function ArtifactView({
  artifactId,
  renderPreview = renderPublishedPreview,
}: {
  artifactId: string;
  renderPreview?: ArtifactRenderer;
}) {
  const qc = useQueryClient();
  const { client, chrome } = useArtifactUI();
  const query = useQuery({
    queryKey: ["artifact", artifactId],
    queryFn: ({ signal }) => readArtifactUpdate(qc, artifactId, signal),
  });
  useEffect(() => {
    document.title = `${query.data?.title || artifactId} · r3`;
  }, [artifactId, query.data?.title]);
  const unavailable =
    query.error instanceof ArtifactApiError && [401, 403, 404, 410].includes(query.error.status);
  useFaviconBadge(!unavailable && (query.data?.unhandledCount ?? 0) > 0);
  useEffect(() => {
    if (unavailable) {
      if (query.error instanceof ArtifactApiError && [401, 403].includes(query.error.status))
        void markdownCache.suspend();
      else void markdownCache.forget(artifactId);
      void draftImages.clear(
        query.error instanceof ArtifactApiError && [401, 403].includes(query.error.status)
          ? undefined
          : artifactId,
      );
      previewSessions.forget(artifactId);
      readingPositions.forget(artifactId);
    }
  }, [unavailable, artifactId, query.error]);
  if (query.error && (!query.data || unavailable))
    return (
      <>
        <AppHeader />
        <main role="alert" className="p-6 text-sm text-red-600">
          {query.error.message}
        </main>
      </>
    );
  if (!query.data)
    return (
      <>
        <AppHeader />
        <main className="flex min-h-0 flex-1">
          <ArtifactLoading />
        </main>
      </>
    );
  return (
    <ArtifactPage
      data={client}
      actions={client}
      chrome={chrome}
      queryClient={qc}
      key={artifactId}
      detail={query.data}
      renderPreview={renderPreview}
      onLocationChange={(view) =>
        history.replaceState(
          history.state,
          "",
          `${location.pathname}${artifactWorkspaceSearch(view, location.search)}`,
        )
      }
    />
  );
}
