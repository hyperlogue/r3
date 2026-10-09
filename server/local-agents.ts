import type { LocalAgentDelivery } from "./artifact-collaboration.ts";
import { pushToListener } from "./listener.ts";

export const deliverLocalAgent: LocalAgentDelivery = async (target, text) => {
  try {
    await pushToListener(target, text);
    return target.harness === "codex" ? "queued" : "sent";
  } catch {
    // Raw process/socket failures can contain credentials or local paths.
    throw new Error(
      target.harness === "codex"
        ? "Codex could not queue the notification. Check that Codex is available, then retry."
        : "Claude Code could not receive the notification. Resume the session and register it again.",
    );
  }
};
