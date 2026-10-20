import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { copyText } from "../clipboard.ts";
import { useTranslation } from "../i18n.ts";
import { Button, cn, StrokeIcon, useCopyFlash } from "../ui.tsx";

export interface NotificationProps {
  title: string;
  message?: string;
  tone?: "info" | "success" | "warning" | "error";
  details?: string;
  command?: string;
  onDismiss: () => void;
}

type Notice = { id: string; content: ReactNode };
const NotificationContext = createContext<{
  put: (notice: Notice) => void;
  remove: (id: string) => void;
} | null>(null);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const parent = useContext(NotificationContext);
  return parent ? children : <NotificationRoot>{children}</NotificationRoot>;
}

function NotificationRoot({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [notices, setNotices] = useState<Notice[]>([]);
  const put = useCallback((notice: Notice) => {
    setNotices((current) => {
      const index = current.findIndex((item) => item.id === notice.id);
      if (index < 0) return [...current, notice];
      return current.map((item, i) => (i === index ? notice : item));
    });
  }, []);
  const remove = useCallback((id: string) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);
  const registry = useMemo(() => ({ put, remove }), [put, remove]);
  return (
    <NotificationContext.Provider value={registry}>
      {children}
      {typeof document !== "undefined" &&
        createPortal(
          <section
            className="r3-notifications"
            aria-label={t("notifications.notifications")}
            data-notifications
          >
            {notices.map((notice) => (
              <div key={notice.id} className="contents">
                {notice.content}
              </div>
            ))}
          </section>,
          document.body,
        )}
    </NotificationContext.Provider>
  );
}

// Custom persistent notices share the same stack as ordinary feedback. Nested
// workspace providers reuse it so navigation never creates overlapping stacks.
export function NotificationSlot({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const registry = useContext(NotificationContext);
  const id = useId();
  useEffect(() => {
    if (!registry) throw new Error(t("notifications.notificationsRequireANotificationprovider"));
    registry.put({ id, content: children });
  }, [registry, id, children, t]);
  useEffect(() => () => registry?.remove(id), [registry, id]);
  return null;
}

// Registration follows the originating component's lifetime, while presentation
// escapes clipped panes and hidden threads containers through one shared portal.
export function Notification({
  title,
  message,
  tone = "info",
  details,
  command,
  onDismiss,
}: NotificationProps) {
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const dismiss = useCallback(() => dismissRef.current(), []);
  return (
    <NotificationSlot>
      <NotificationCard notice={{ title, message, tone, details, command, onDismiss: dismiss }} />
    </NotificationSlot>
  );
}

function NotificationCard({ notice }: { notice: NotificationProps }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const { copied, flash } = useCopyFlash();
  useEffect(() => {
    if (notice.tone !== "success" || hovered || focused) return;
    const timer = setTimeout(notice.onDismiss, 5000);
    return () => clearTimeout(timer);
  }, [notice, hovered, focused]);
  return (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      className="r3-notification r3-popover flex items-start gap-2.5 rounded-lg border border-neutral-300 bg-white p-3 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
      data-notification-tone={notice.tone}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
      }}
    >
      <StrokeIcon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          notice.tone === "success" && "text-success-600 dark:text-success-400",
          notice.tone === "warning" && "text-warning-600 dark:text-warning-400",
          notice.tone === "error" && "text-danger-600 dark:text-danger-400",
          notice.tone === "info" && "text-primary-600 dark:text-primary-400",
        )}
      >
        {notice.tone === "success" ? (
          <path d="m5 12 4 4L19 6" />
        ) : (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v6m0 3v1" />
          </>
        )}
      </StrokeIcon>
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <p className="font-semibold text-neutral-900 dark:text-neutral-100">{notice.title}</p>
        {notice.message && <p className="mt-1 leading-relaxed">{notice.message}</p>}
        {notice.command && (
          <div className="mt-2 flex items-start gap-1 border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-900">
            <code className="min-w-0 flex-1 select-text break-all text-[0.6875rem] leading-5">
              {notice.command}
            </code>
            <Button
              variant="ghost"
              className="shrink-0 p-1!"
              aria-label={copied ? t("common.commandCopied") : t("notifications.copyFetchCommand")}
              onClick={async () => {
                setCopyFailed(false);
                if (await copyText(notice.command!)) flash();
                else setCopyFailed(true);
              }}
            >
              <StrokeIcon className="size-3.5">
                {copied ? (
                  <path d="m5 12 4 4L19 6" />
                ) : (
                  <>
                    <rect x="9" y="9" width="12" height="12" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </>
                )}
              </StrokeIcon>
            </Button>
          </div>
        )}
        {copyFailed && <p className="mt-1">{t("notifications.selectAndCopyTheCommandAbove")}</p>}
        {notice.details && (
          <details className="mt-2 text-neutral-500 dark:text-neutral-400">
            <summary className="cursor-pointer">{t("notifications.deliveryDetails")}</summary>
            <p className="mt-1 whitespace-pre-wrap">{notice.details}</p>
          </details>
        )}
      </div>
      <Button
        variant="ghost"
        className="-mr-1 -mt-1 shrink-0 p-1!"
        aria-label={t("notifications.dismiss", { notice_title: notice.title })}
        onClick={notice.onDismiss}
      >
        <StrokeIcon className="size-3.5">
          <path d="m6 6 12 12M18 6 6 18" />
        </StrokeIcon>
      </Button>
    </div>
  );
}
