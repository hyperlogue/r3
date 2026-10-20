import { commentFetchCommand } from "../artifact-handoff.ts";
import { useTranslation } from "../i18n.ts";
import type { useArtifactHandoff } from "../useArtifactHandoff.ts";
import { Notification } from "./Notifications.tsx";

export const AGENT_DELIVERY_HELP = "common.checkThatYourAgentSessionIsStill";

export function ArtifactHandoffNotice({
  handoff,
}: {
  handoff: ReturnType<typeof useArtifactHandoff>;
}) {
  const { t } = useTranslation();
  if (!handoff.notice && !handoff.error) return null;
  return (
    <Notification
      title={
        handoff.error
          ? t("handoffNotice.agentNotificationFailed")
          : t("handoffNotice.agentNotified")
      }
      message={handoff.error ? t(AGENT_DELIVERY_HELP) : handoff.notice}
      tone={handoff.error ? "error" : "success"}
      details={handoff.error?.message}
      command={handoff.error ? commentFetchCommand(handoff.artifactId) : undefined}
      onDismiss={handoff.dismiss}
    />
  );
}
