import type { ProjectGroupingOptions } from "./artifact-projects.ts";
import { DEFAULT_AUTH_TOKEN_IDLE_DAYS } from "./auth.ts";
import type { PersistedConfig } from "./config.ts";

export function artifactAuthSettings(
  environment: Record<string, string | undefined>,
  persisted: PersistedConfig,
): { authTokenIdleDays: number } {
  const supplied = environment.R3_AUTH_TOKEN_IDLE_DAYS?.trim();
  const days = supplied
    ? Number(supplied)
    : (persisted.authTokenIdleDays ?? DEFAULT_AUTH_TOKEN_IDLE_DAYS);
  if (!Number.isSafeInteger(days) || days < 1)
    throw new Error("authTokenIdleDays must be a positive integer");
  return { authTokenIdleDays: days };
}

export function artifactProjectSettings(
  environment: Record<string, string | undefined>,
  persisted: PersistedConfig,
): ProjectGroupingOptions {
  const mode = environment.R3_PROJECT_GROUPING?.trim() || persisted.projectGrouping || "remote";
  if (mode !== "remote" && mode !== "manual")
    throw new Error("projectGrouping must be remote or manual");
  return { mode, mappings: persisted.projectMappings };
}
