import type { Database } from "bun:sqlite";
import type { ArtifactActor } from "../shared/artifacts.ts";
import type { WorkerSubscription } from "../shared/worker-protocol.ts";
import { ArtifactError, canonicalJson } from "./artifact-validation.ts";

export const WORKER_SCHEMA = `
CREATE TABLE IF NOT EXISTS worker_registrations (
  id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK(json_valid(body)), state TEXT NOT NULL CHECK(state IN ('active','disconnected','retired'))
) STRICT;
`;
export class WorkerRecords {
  constructor(private readonly db: Database) {}
  startup(): void {
    this.db.exec("UPDATE worker_registrations SET state='disconnected' WHERE state='active'");
  }
  get(id: string): { workerId: string; subscription: WorkerSubscription; state: string } | null {
    const row = this.db
      .query<{ workerId: string; body: string; state: string }, [string]>(
        "SELECT worker_id AS workerId,body,state FROM worker_registrations WHERE id=?",
      )
      .get(id);
    return row
      ? { workerId: row.workerId, subscription: JSON.parse(row.body), state: row.state }
      : null;
  }
  save(workerId: string, subscription: WorkerSubscription): void {
    const current = this.get(subscription.id);
    if (current?.state === "retired") throw new ArtifactError("Registration has ended", 409);
    if (
      current &&
      (current.workerId !== workerId ||
        canonicalJson(current.subscription) !== canonicalJson(subscription))
    )
      throw new ArtifactError("Registration identity was already used", 409);
    this.db
      .query(
        "INSERT INTO worker_registrations(id,worker_id,artifact_id,body,state) VALUES(?,?,?,?,'active') ON CONFLICT(id) DO UPDATE SET state='active'",
      )
      .run(subscription.id, workerId, subscription.artifactId, JSON.stringify(subscription));
  }
  state(id: string, state: "disconnected" | "retired"): void {
    this.db
      .query("UPDATE worker_registrations SET state=? WHERE id=? AND state!='retired'")
      .run(state, id);
  }
  retire(
    artifactId: string,
    mode: "fallback" | "explicit" | null = null,
    actor: ArtifactActor | null = null,
    except = "",
  ): void {
    this.db
      .query(`UPDATE worker_registrations SET state='retired' WHERE artifact_id=? AND id!=?
      AND (? IS NULL OR json_extract(body,'$.mode')=?)
      AND (? IS NULL OR json_extract(body,'$.actor.sessionId')=?)`)
      .run(artifactId, except, mode, mode, actor?.sessionId ?? null, actor?.sessionId ?? null);
  }
  adoptLocal(workerId: string, subscription: WorkerSubscription): void {
    const row = this.db
      .query<{ sessionId: string; mode: string; artifactId: string }, [string]>(
        "SELECT session_id AS sessionId,mode,artifact_id AS artifactId FROM artifact_listeners WHERE id=?",
      )
      .get(subscription.id);
    if (
      !row ||
      row.sessionId !== subscription.actor.sessionId ||
      row.artifactId !== subscription.artifactId ||
      row.mode !== subscription.mode
    )
      throw new ArtifactError("Saved registration is no longer eligible", 409);
    this.atomic(() => {
      this.save(workerId, subscription);
      this.state(subscription.id, "disconnected");
      this.db.query("DELETE FROM artifact_listeners WHERE id=?").run(subscription.id);
      this.db.exec(
        "DELETE FROM local_agent_targets WHERE NOT EXISTS (SELECT 1 FROM artifact_listeners WHERE session_id=local_agent_targets.session_id)",
      );
    });
  }
  atomic<T>(action: () => T): T {
    return this.db.transaction(action).immediate();
  }
}
