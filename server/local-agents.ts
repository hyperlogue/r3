import type { ListenerTarget } from "../shared/types.ts";
import { pushToListener } from "./listener.ts";

export async function deliverLocalAgent(
  target: ListenerTarget,
  text: string,
): Promise<"sent" | "queued"> {
  try {
    await pushToListener(target, text);
    return target.harness === "claude" ? "sent" : "queued";
  } catch {
    // Raw process/socket failures can contain credentials or local paths.
    throw new Error(
      target.harness === "codex"
        ? "Codex could not queue the notification. Check that Codex is available, then retry."
        : target.harness === "antigravity"
          ? "Antigravity could not queue the notification. Keep its session running and register it again."
          : "Claude Code could not receive the notification. Resume the session and register it again.",
    );
  }
}
