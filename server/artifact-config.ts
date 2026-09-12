import type { PersistedConfig } from "./config.ts";

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
