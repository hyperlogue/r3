import { startArtifactDaemon } from "./artifact-daemon.ts";

if (import.meta.main) await startArtifactDaemon();
