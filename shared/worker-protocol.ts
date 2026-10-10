import type {
  ArtifactActor,
  ArtifactDeliveryState,
  ArtifactNudge,
  ArtifactWatcher,
} from "./artifacts.ts";

export const WORKER_PROTOCOL = "r3-worker-v2";
export const WORKER_DESTINATION_LIMIT = 4096;
export type ListenerRole = "fallback" | "explicit";
export interface WorkerSubscription {
  id: string;
  artifactId: string;
  listenerId: string;
  actor: ArtifactActor;
  mode: ListenerRole;
}
export type WorkerEvent =
  | {
      type: "ready";
      protocol: typeof WORKER_PROTOCOL;
      connectionId: string;
      listenerIds?: string[];
    }
  | { type: "heartbeat" }
  | { type: "registered"; subscription: WorkerSubscription; registration: ArtifactWatcher }
  | { type: "retired"; registrationId: string; reason: string }
  | { type: "nudge"; registrationId: string; listenerId: string; nudge: ArtifactNudge }
  | { type: "closed"; reason: string };
export interface WorkerAcknowledgment {
  nudgeId: string;
  ok: boolean;
  state?: ArtifactDeliveryState;
}
