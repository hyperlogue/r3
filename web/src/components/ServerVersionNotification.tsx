import { useId, useState, useSyncExternalStore } from "react";
import { compareVersions, R3_VERSION } from "../../../shared/version.ts";
import { artifactDrafts } from "../artifact-drafts.ts";
import { useTranslation } from "../i18n.ts";
import { serverVersion } from "../server-version.ts";

import { Button, StrokeIcon } from "../ui.tsx";
import { NotificationSlot } from "./Notifications.tsx";

export function ServerVersionNotification() {
  const { t } = useTranslation();
  const version = useSyncExternalStore(serverVersion.subscribe, serverVersion.getSnapshot);
  const [saveFailed, setSaveFailed] = useState(false);
  const messageId = useId();
  if (!version) return null;
  const upgraded = compareVersions(version, R3_VERSION)! > 0;
  return (
    <NotificationSlot>
      <div
        className="r3-server-update r3-notification r3-popover rounded-lg border bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100"
        data-server-version={version}
      >
        <StrokeIcon className="r3-server-update-icon text-primary-600 dark:text-primary-400">
          <path d="M5 3h14M12 20V7m-5 5 5-5 5 5" />
        </StrokeIcon>
        <div className="r3-server-update-copy" role="status" aria-live="polite" aria-atomic="true">
          <div>
            <p className="font-semibold">
              {t("common.serverToV", {
                upgraded_updated_changed: t(
                  upgraded
                    ? "serverVersionNotification.updated"
                    : "serverVersionNotification.changed",
                ),
                version: version,
              })}
            </p>
            <p
              id={messageId}
              className="r3-server-update-message text-neutral-600 dark:text-neutral-400"
            >
              {saveFailed
                ? t("serverVersionNotification.draftsCouldnTBeSavedCopyThem")
                : t("serverVersionNotification.refreshToMatchTheServer")}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="primary"
          className="r3-server-update-action"
          aria-label={t("serverVersionNotification.refreshPage")}
          aria-describedby={messageId}
          title={t("serverVersionNotification.reloadThisPageToUseTheSame")}
          onClick={() => {
            if (!artifactDrafts.flush()) {
              setSaveFailed(true);
              return;
            }
            location.reload();
          }}
        >
          {t("serverVersionNotification.refresh")}
        </Button>
      </div>
    </NotificationSlot>
  );
}
