import type { ProjectGroupingOptions } from "./artifact-projects.ts";
import type { PersistedConfig } from "./config.ts";

export function artifactProjectSettings(
  environment: Record<string, string | undefined>,
  persisted: PersistedConfig,
): ProjectGroupingOptions {
  const mode = environment.R3_PROJECT_GROUPING?.trim() || persisted.projectGrouping || "remote";
  if (mode !== "remote" && mode !== "manual")
    throw new Error("projectGrouping must be remote or manual");
  return { mode, mappings: persisted.projectMappings };
}

export function artifactPreviewSettings(
  environment: Record<string, string | undefined>,
  persisted: PersistedConfig,
  applicationPort: number,
): { port?: number; baseUrl?: string } {
  const baseUrl = environment.R3_PREVIEW_BASE_URL?.trim() || persisted.previewBaseUrl || undefined;
  if (!baseUrl) return {};
  const supplied = environment.R3_PREVIEW_PORT?.trim();
  const port = supplied ? Number(supplied) : (persisted.previewPort ?? applicationPort + 1);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === applicationPort)
    throw new Error(
      "previewPort must be a different port from the application, between 1 and 65535",
    );
  return { port, baseUrl };
}
