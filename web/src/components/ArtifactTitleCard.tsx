import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { ArtifactDetail } from "../../../shared/artifacts.ts";
import { formatBytes } from "../format-bytes.ts";
import { getLanguageTag, useTranslation } from "../i18n.ts";
import { relativeArtifactTime } from "../relative-artifact-time.ts";
import { CopyMeta, useEscape } from "../ui.tsx";
import { AgentName } from "./AgentName.tsx";

const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 150;

function Time({ value, now }: { value: string; now: number }) {
  return (
    <time dateTime={value} title={new Date(value).toLocaleString(getLanguageTag())}>
      {relativeArtifactTime(value, now)}
    </time>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-neutral-500 dark:text-neutral-400">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

export function ArtifactTitleCard({ detail }: { detail: ArtifactDetail }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardId = useId();
  const schedule = (next: boolean, delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), delay);
  };
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useEscape(open, () => setOpen(false));
  const label = detail.title || detail.id;
  const latest = detail.versions.at(-1);
  const now = Date.now();
  const kind = {
    html: t("kindIcon.htmlArtifact"),
    files: t("kindIcon.filesArtifact"),
    diff: t("kindIcon.diffArtifact"),
  }[detail.kind];
  return (
    <div
      className="relative flex min-w-0 items-center self-stretch"
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") schedule(true, OPEN_DELAY_MS);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") schedule(false, CLOSE_DELAY_MS);
      }}
      onFocus={(event) => {
        if (event.target.matches(":focus-visible")) schedule(true, 0);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) schedule(false, 0);
      }}
    >
      <button
        type="button"
        aria-controls={open ? cardId : undefined}
        aria-expanded={open}
        data-artifact-title
        onClick={() => schedule(true, 0)}
        className="min-w-0 cursor-default truncate rounded-sm pr-2 text-left text-sm font-semibold focus-visible:outline-2 focus-visible:outline-primary-500"
      >
        {label}
      </button>
      {open && (
        <div
          id={cardId}
          role="dialog"
          aria-label={t("titleCard.label")}
          data-artifact-title-card
          className="absolute left-0 top-full z-50 mt-1 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-neutral-300 bg-white p-3 text-xs font-normal text-neutral-900 r3-popover dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
        >
          {detail.title && (
            <p className="mb-2 text-sm font-semibold [overflow-wrap:anywhere]">{detail.title}</p>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <Row label={t("titleCard.id")}>
              <span className="font-mono">
                <CopyMeta hint={t("header.copyArtifactId")} value={detail.id}>
                  {detail.id}
                </CopyMeta>
              </span>
            </Row>
            <Row label={t("titleCard.kind")}>{kind}</Row>
            {detail.state === "archived" && (
              <Row label={t("titleCard.state")}>{t("common.archived")}</Row>
            )}
            {latest && (
              <Row label={t("titleCard.latest")}>
                v{latest.seq} · <Time value={latest.publishedAt} now={now} />
              </Row>
            )}
            <Row label={t("titleCard.created")}>
              <Time value={detail.createdAt} now={now} />
            </Row>
            <Row label={t("titleCard.updated")}>
              <Time value={detail.updatedAt} now={now} />
            </Row>
            {detail.createdBy.role === "agent" && (
              <Row label={t("titleCard.publisher")}>
                <AgentName id={detail.createdBy.sessionId} labels={detail.agentLabels} />
              </Row>
            )}
            <Row label={t("titleCard.storage")}>{formatBytes(detail.storage.totalBytes)}</Row>
            {Object.entries(detail.meta).map(([key, value]) => (
              <Row key={key} label={key}>
                {value}
              </Row>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
