// Only application settings/auth live here. Artifact requests and event streams
// use artifact-api.ts, with the same public contract as the daemon.
import { ArtifactApiError } from "../../shared/artifact-client.ts";
import type { OnboardingState, UpdateOnboardingBody } from "../../shared/artifacts.ts";
import { demo, fail } from "./artifact-backend.ts";

export { ArtifactApiError as ApiError };
export const TOKEN = "";
export const CAN_MANAGE_TOKENS = false;
export const LOGIN_NOTICE = false;
export const loadBoot = async () => ({ needsAuth: false });
export const api = {
  // The scripted public demo opts out of automatic onboarding. Replay still works.
  onboarding: async (): Promise<OnboardingState> => ({ status: "completed", updatedAt: null }),
  updateOnboarding: async (_body: UpdateOnboardingBody): Promise<OnboardingState> => ({
    status: "completed",
    updatedAt: null,
  }),
  themes: async () => structuredClone(demo.state.themes),
  themeStyle: async (theme?: string) =>
    structuredClone(
      demo.state.themeStyles[theme ?? ""] ?? Object.values(demo.state.themeStyles)[0],
    ),
  login: async () => ({ ok: true }),
  logout: async () => ({ ok: true }),
  authTokens: async () => [],
  createAuthToken: async (): Promise<never> =>
    fail("Access tokens are not used in this static demo"),
  revokeAuthToken: async () => ({ ok: true }),
};
