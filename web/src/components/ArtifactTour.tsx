import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ArtifactKind, UpdateOnboardingBody } from "../../../shared/artifacts.ts";
import { api } from "../api.ts";
import type { ArtifactTourWorkspace } from "../artifact-ui-context.tsx";
import { useDarkTheme } from "../hooks.ts";
import { type AppMessageKey, useTranslation } from "../i18n.ts";
import { useProductTour } from "../product-tour-context.tsx";
import { Button } from "../ui.tsx";
import tourStyles from "./artifact-tour.css" with { type: "text" };

type Step = {
  id: string;
  title: AppMessageKey;
  body: AppMessageKey;
  selectors: string[];
  discussion?: boolean;
};
const content = "[data-artifact-content-view]";
function stepsFor(kind: ArtifactKind, active: boolean, commentModeAvailable: boolean): Step[] {
  return [
    { id: "content", title: "tour.contentTitle", body: "tour.contentBody", selectors: [content] },
    {
      id: "versions",
      title: "tour.versionsTitle",
      body: "tour.versionsBody",
      selectors: ['[data-tour="versions"]', '[data-tour="details"]'],
    },
    ...(kind === "html"
      ? []
      : [
          {
            id: "files",
            title: "tour.filesTitle",
            body: "tour.filesBody",
            selectors: ['[data-tour="files"]'],
          } satisfies Step,
        ]),
    ...(active
      ? [
          {
            id: commentModeAvailable ? "comment-mode" : "anchor",
            title: commentModeAvailable ? "tour.commentModeTitle" : "tour.anchorTitle",
            body: commentModeAvailable
              ? "tour.commentModeBody"
              : kind === "diff"
                ? "tour.anchorDiff"
                : "tour.anchorFiles",
            selectors: commentModeAvailable
              ? ['[data-tour="comment-mode"]']
              : ["[data-gutter]", content],
          } satisfies Step,
          {
            id: "comment",
            title: "tour.commentTitle",
            body: "tour.commentBody",
            selectors: ['[data-tour="comment"]'],
            discussion: true,
          } satisfies Step,
          {
            id: "handoff",
            title: "tour.handoffTitle",
            body: "tour.handoffBody",
            selectors: [
              "[data-discussion-header] [data-artifact-handoff]",
              "[data-artifact-handoff]",
            ],
            discussion: true,
          } satisfies Step,
        ]
      : []),
    {
      id: "threads",
      title: "tour.threadsTitle",
      body: "tour.threadsBody",
      selectors: ['[data-discussion-header] [role="tablist"]'],
      discussion: true,
    },
  ];
}

// Inert hidden docks and clipped/virtualized rows are not spotlight candidates.
function visible(element: Element, workspace?: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.checkVisibility({ checkVisibilityCSS: true }))
    return false;
  const inert = element.closest("[inert]");
  if (inert && inert !== workspace) return false;
  const r = element.getBoundingClientRect();
  return (
    r.width > 0 &&
    r.height > 0 &&
    r.bottom > 0 &&
    r.top < innerHeight &&
    r.right > 0 &&
    r.left < innerWidth
  );
}

export function ArtifactTour(props: ArtifactTourWorkspace) {
  const { root, ready, revealDiscussion } = props;
  const controller = useProductTour();
  const register = controller?.register;
  const qc = useQueryClient();
  const state = useQuery({ queryKey: ["onboarding"], queryFn: api.onboarding, staleTime: 0 });
  const [run, setRun] = useState(0);
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const [clear, setClear] = useState(false);
  const dismissed = useRef(false);
  const restart = useCallback(() => {
    setRun((value) => value + 1);
    setIndex(0);
    setOpen(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    register?.(restart);
    return () => register?.(null);
  }, [register, restart, ready]);
  useEffect(() => {
    if (!ready || (!open && (dismissed.current || state.data?.status !== "new"))) {
      setClear(false);
      return;
    }
    const check = () => {
      const blocked = [
        ...document.querySelectorAll(
          '[role="dialog"], dialog[open], [data-preview-compatibility-consent]',
        ),
      ].some((element) => visible(element, root.current ?? undefined));
      const typing = document.activeElement?.matches("input, textarea, [contenteditable=true]");
      setClear(!blocked && (open || !typing));
    };
    check();
    const timer = setInterval(check, 200);
    return () => clearInterval(timer);
  }, [ready, open, state.data?.status, root]);
  useEffect(() => {
    if (clear && state.data?.status === "new" && !dismissed.current) setOpen(true);
  }, [clear, state.data?.status]);
  const close = useCallback(() => {
    dismissed.current = true;
    setOpen(false);
    revealDiscussion(false);
  }, [revealDiscussion]);
  // A new publication must not restart or replace the current walkthrough.
  if (!open || !ready || !clear) return null;
  return (
    <TourOverlay
      key={run}
      {...props}
      index={index}
      onStep={setIndex}
      onClose={close}
      onSave={async (status) => {
        const saved = await api.updateOnboarding({ status });
        qc.setQueryData(["onboarding"], saved);
      }}
    />
  );
}

function TourOverlay({
  detail,
  commentModeAvailable,
  root,
  revealDiscussion,
  index,
  onStep,
  onClose,
  onSave,
}: ArtifactTourWorkspace & {
  index: number;
  onStep: (index: number) => void;
  onClose: () => void;
  onSave: (status: UpdateOnboardingBody["status"]) => Promise<void>;
}) {
  const { t } = useTranslation();
  const dark = useDarkTheme();
  const [steps] = useState(() =>
    stepsFor(detail.kind, detail.state === "active", commentModeAvailable),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const saving = useRef(false);
  const [host] = useState(() => document.createElement("div"));
  const [shadow] = useState(() => host.shadowRoot ?? host.attachShadow({ mode: "open" }));
  const card = useRef<HTMLDivElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const spotlight = useRef<HTMLDivElement>(null);
  const step = steps[Math.min(index, steps.length - 1)];
  const finish = useCallback(
    async (status: UpdateOnboardingBody["status"]) => {
      if (saving.current) return;
      saving.current = true;
      setBusy(true);
      setError(false);
      try {
        await onSave(status);
        onClose();
      } catch {
        setError(true);
      } finally {
        saving.current = false;
        setBusy(false);
      }
    },
    [onSave, onClose],
  );
  const finishRef = useRef(finish);
  finishRef.current = finish;
  useLayoutEffect(() => {
    host.dataset.productTour = "";
    document.body.append(host);
    const workspace = root.current;
    const previousInert = workspace?.inert ?? false;
    const previousFocus = document.activeElement;
    // Only this trusted workspace is inert. Do not change preview permissions or
    // use showModal(), which also makes independent preview controls inert.
    if (workspace) workspace.inert = true;
    const focus = () => next.current?.focus({ preventScroll: true });
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!event.repeat) void finishRef.current("skipped");
      } else if (event.key === "Tab") {
        const buttons = [...shadow.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
        const current = buttons.indexOf(shadow.activeElement as HTMLButtonElement);
        event.preventDefault();
        buttons[(current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
      // Background shortcuts must not change versions, drafts, or delivery.
      event.stopImmediatePropagation();
    };
    const containFocus = (event: FocusEvent) => {
      if (!event.composedPath().includes(host)) focus();
    };
    window.addEventListener("keydown", keyboard, true);
    document.addEventListener("focusin", containFocus, true);
    focus();
    return () => {
      window.removeEventListener("keydown", keyboard, true);
      document.removeEventListener("focusin", containFocus, true);
      if (workspace) workspace.inert = previousInert;
      host.remove();
      const restore =
        previousFocus instanceof HTMLElement &&
        previousFocus.isConnected &&
        previousFocus !== document.body &&
        !previousFocus.closest("[inert]")
          ? previousFocus
          : workspace?.querySelector<HTMLButtonElement>('[data-tour="details"]');
      restore?.focus({ preventScroll: true });
    };
  }, [host, shadow, root]);
  useEffect(() => {
    revealDiscussion(!!step.discussion);
    return () => revealDiscussion(false);
  }, [step, revealDiscussion]);
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      const workspace = root.current;
      const target = step.selectors
        .flatMap((selector) => [...(workspace?.querySelectorAll(selector) ?? [])])
        .find((element) => visible(element, workspace ?? undefined));
      const rect = target?.getBoundingClientRect();
      const left = Math.max(0, (rect?.left ?? 0) - 5);
      const top = Math.max(0, (rect?.top ?? 0) - 5);
      const right = Math.min(innerWidth, (rect?.right ?? 0) + 5);
      const bottom = Math.min(innerHeight, (rect?.bottom ?? 0) + 5);
      const width = Math.max(0, right - left);
      const height = Math.max(0, bottom - top);
      const cardWidth = card.current?.offsetWidth ?? 360;
      const cardHeight = card.current?.offsetHeight ?? 240;
      // Prefer a free side of the spotlight; large content panes use a corner.
      let cardLeft = left;
      let cardTop = bottom + 16;
      if (cardTop + cardHeight > innerHeight - 16) {
        if (top - cardHeight - 16 >= 16) cardTop = top - cardHeight - 16;
        else if (left - cardWidth - 16 >= 16) {
          cardLeft = left - cardWidth - 16;
          cardTop = top;
        } else if (right + cardWidth + 16 <= innerWidth - 16) {
          cardLeft = right + 16;
          cardTop = top;
        } else {
          cardLeft = right - cardWidth - 16;
          cardTop = bottom - cardHeight - 16;
        }
      }
      // Commit measured coordinates before this frame paints. React state from
      // requestAnimationFrame can commit a frame later, behind a moving target.
      if (spotlight.current)
        Object.assign(spotlight.current.style, {
          left: `${left}px`,
          top: `${top}px`,
          width: `${width}px`,
          height: `${height}px`,
        });
      if (card.current)
        Object.assign(card.current.style, {
          left: `${Math.max(16, Math.min(innerWidth - cardWidth - 16, cardLeft))}px`,
          top: `${Math.max(16, Math.min(innerHeight - cardHeight - 16, cardTop))}px`,
        });
      frame = requestAnimationFrame(measure);
    };
    // Tracks native dock transitions, resizing, and asynchronously hydrated rows.
    measure();
    next.current?.focus({ preventScroll: true });
    return () => cancelAnimationFrame(frame);
  }, [root, step]);
  return createPortal(
    <>
      <style>{tourStyles}</style>
      <div className={`tour-layer ${dark ? "dark" : ""}`}>
        <div className="tour-shield" />
        <div ref={spotlight} className="tour-spotlight" aria-hidden="true" />
        <div
          ref={card}
          role="dialog"
          aria-modal="true"
          aria-labelledby="tour-title"
          aria-describedby="tour-body"
          className="tour-card"
          data-step={step.id}
        >
          <div aria-live="polite" aria-atomic="true">
            <div className="tour-heading">
              <span>{t("tour.label")}</span>
              <span>{t("tour.progress", { current: index + 1, total: steps.length })}</span>
            </div>
            <h2 id="tour-title">{t(step.title)}</h2>
            <p id="tour-body">
              {t(
                step.id === "versions" &&
                  !root.current?.querySelector('[data-tour="versions"]')?.checkVisibility()
                  ? "tour.versionsMenuBody"
                  : step.body,
              )}
            </p>
          </div>
          {error && (
            <div>
              <p role="alert" className="tour-error">
                {t("tour.saveError")}
              </p>
              <Button className="tour-button" onClick={onClose}>
                {t("common.close")}
              </Button>
            </div>
          )}
          <div className="tour-actions">
            <Button
              className="tour-button tour-skip"
              onClick={() => void finish("skipped")}
              disabled={busy}
            >
              {t("tour.skip")}
            </Button>
            <Button
              className="tour-button"
              onClick={() => onStep(index - 1)}
              disabled={busy || index === 0}
            >
              {t("tour.back")}
            </Button>
            <Button
              ref={next}
              variant="primary"
              className="tour-button tour-primary"
              disabled={busy}
              onClick={() =>
                index >= steps.length - 1 ? void finish("completed") : onStep(index + 1)
              }
            >
              {t(busy ? "tour.saving" : index >= steps.length - 1 ? "tour.finish" : "tour.next")}
            </Button>
          </div>
        </div>
      </div>
    </>,
    shadow,
  );
}
