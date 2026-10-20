import { commentFetchCommand } from "../artifact-handoff.ts";
import { t, useLocale } from "../i18n.ts";
import type { useArtifactHandoff } from "../useArtifactHandoff.ts";
import { Notification } from "./Notifications.tsx";

export const AGENT_DELIVERY_HELP =
  "Check that your agent session is still running and listening to this artifact. You can also run the command below in that session to fetch comments.";

export function ArtifactHandoffNotice({
  handoff,
}: {
  handoff: ReturnType<typeof useArtifactHandoff>;
}) {
  useLocale();
  if (!handoff.notice && !handoff.error) return null;
  return (
    <Notification
      title={handoff.error ? t("Agent notification failed") : t("Agent notified")}
      message={handoff.error ? t(AGENT_DELIVERY_HELP) : handoff.notice}
      tone={handoff.error ? "error" : "success"}
      details={handoff.error?.message}
      command={handoff.error ? commentFetchCommand(handoff.artifactId) : undefined}
      onDismiss={handoff.dismiss}
    />
  );
}
