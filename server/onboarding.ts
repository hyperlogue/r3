import type { Database } from "bun:sqlite";
import type { OnboardingState } from "../shared/artifacts.ts";
import { ArtifactError } from "./artifact-validation.ts";

export const ONBOARDING_SCHEMA = `
CREATE TABLE IF NOT EXISTS onboarding (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL CHECK (status IN ('skipped', 'completed')),
  updated_at TEXT NOT NULL
) STRICT;
`;

// Installation state belongs to the backend, independently of artifacts and browsers.
export class OnboardingStore {
  constructor(
    private db: Database,
    private clock: () => string,
  ) {}

  read(): OnboardingState {
    return (
      this.db
        .query<OnboardingState, []>(
          "SELECT status, updated_at AS updatedAt FROM onboarding WHERE id = 1",
        )
        .get() ?? { status: "new", updatedAt: null }
    );
  }

  update(input: Record<string, unknown>): OnboardingState {
    if (input.status !== "skipped" && input.status !== "completed")
      throw new ArtifactError("status must be skipped or completed");
    // Replays and stale tabs cannot downgrade completion or reset its timestamp.
    this.db
      .query(`INSERT INTO onboarding (id, status, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at
      WHERE onboarding.status = 'skipped' AND excluded.status = 'completed'`)
      .run(input.status, this.clock());
    return this.read();
  }
}
