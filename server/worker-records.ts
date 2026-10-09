import type { Database } from "bun:sqlite";
import type { ArtifactActor } from "../shared/artifacts.ts";
import type { WorkerSubscription } from "../shared/worker-protocol.ts";
import { ArtifactError, canonicalJson } from "./artifact-validation.ts";

export const WORKER_SCHEMA = `
CREATE TABLE IF NOT EXISTS worker_registrations (
  id TEXT PRIMARY KEY, worker_id TEXT NOT NULL, principal TEXT NOT NULL, artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK(json_valid(body)), state TEXT NOT NULL CHECK(state IN ('active','disconnected','retired'))
) STRICT;
`;
export interface WorkerRecord {
  workerId: string;
  principal: string;
  subscription: WorkerSubscription;
  state: string;
}

export class WorkerRecords {
  constructor(private readonly db: Database) {}
  startup(): void {
    this.db.exec("UPDATE worker_registrations SET state='disconnected' WHERE state='active'");
  }
  get(id: string): WorkerRecord | null {
    const row = this.db
      .query<{ workerId: string; principal: string; body: string; state: string }, [string]>(
        "SELECT worker_id AS workerId,principal,body,state FROM worker_registrations WHERE id=?",
      )
      .get(id);
    return row
      ? {
          workerId: row.workerId,
          principal: row.principal,
          subscription: JSON.parse(row.body),
          state: row.state,
        }
      : null;
  }
  retained(): WorkerRecord[] {
    return this.db
      .query<{ id: string }, []>("SELECT id FROM worker_registrations WHERE state != 'retired'")
      .all()
      .map(({ id }) => this.get(id)!);
  }
  save(workerId: string, principal: string, subscription: WorkerSubscription): void {
    const current = this.get(subscription.id);
    if (current?.state === "retired") throw new ArtifactError("Registration has ended", 409);
    if (
      current &&
      (current.workerId !== workerId ||
        current.principal !== principal ||
        canonicalJson(current.subscription) !== canonicalJson(subscription))
    )
      throw new ArtifactError("Registration identity was already used", 409);
    this.db
      .query(
        "INSERT INTO worker_registrations(id,worker_id,principal,artifact_id,body,state) VALUES(?,?,?,?,?,'active') ON CONFLICT(id) DO UPDATE SET state='active'",
      )
      .run(
        subscription.id,
        workerId,
        principal,
        subscription.artifactId,
        JSON.stringify(subscription),
      );
  }
  state(id: string, state: "active" | "disconnected" | "retired"): void {
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
}
