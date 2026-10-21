import { useId, useLayoutEffect, useRef, useState } from "react";
import { Trans } from "react-i18next";
import { LOGIN_NOTICE } from "../api.ts";
import { readDisplayPreference, writeDisplayPreference } from "../display-storage.ts";
import { appI18n, getLocale, useTranslation } from "../i18n.ts";
import { suspendKeys } from "../keys.ts";
import { Button, StrokeIcon } from "../ui.tsx";

// Seen once per browser and application origin; storage failure only repeats it.
const storageKey = "r3-login-disabled-notice";
const DOCS = "https://hyperlogue.github.io/r3";

export function LoginDisabledNotice() {
  const [open, setOpen] = useState(
    () => LOGIN_NOTICE && readDisplayPreference(storageKey) === null,
  );
  if (!open) return null;
  return (
    <LoginDisabledDialog
      onClose={() => {
        writeDisplayPreference(storageKey, "seen");
        setOpen(false);
      }}
    />
  );
}

function LoginDisabledDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const dismiss = useRef<HTMLButtonElement>(null);
  const title = useId();
  const description = useId();
  useLayoutEffect(() => {
    const node = dialog.current;
    const resume = suspendKeys();
    node?.showModal();
    // Focus the action instead of the first link, which showModal would pick.
    dismiss.current?.focus();
    return () => {
      node?.close();
      resume();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      data-login-disabled-notice
      aria-labelledby={title}
      aria-describedby={description}
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-auto rounded-xl border border-neutral-300 bg-white p-5 text-neutral-900 r3-modal backdrop:bg-black/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
    >
      <h2 id={title} className="flex items-center gap-2.5 text-lg font-semibold">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-warning-100 text-warning-700 dark:bg-warning-400/15 dark:text-warning-400">
          <StrokeIcon className="size-5">
            <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3" />
            <path d="M12 9v4" />
            <path d="M12 17h.01" />
          </StrokeIcon>
        </span>
        <span>
          <Trans
            i18n={appI18n}
            ns="app"
            i18nKey="loginDisabledNotice.title"
            components={{ em: <em className="text-warning-700 dark:text-warning-400" /> }}
          />
        </span>
      </h2>
      <div
        id={description}
        className="mt-3 space-y-3 text-sm text-neutral-600 dark:text-neutral-300"
      >
        <p>{t("loginDisabledNotice.risk")}</p>
        <p>{t("loginDisabledNotice.enable")}</p>
        <pre className="whitespace-pre-wrap rounded bg-neutral-100 p-2 font-mono text-xs dark:bg-neutral-800">
          {
            "r3 config set requireLogin true\nr3 server restart\nr3 auth create-token --label browser"
          }
        </pre>
        <p>{t("loginDisabledNotice.signIn")}</p>
        <p>
          <a
            href={`${DOCS}${getLocale() === "en" ? "" : `/${getLocale()}`}/docs/access/`}
            target="_blank"
            rel="noreferrer"
            className="text-blue-700 underline dark:text-blue-400"
          >
            {t("loginDisabledNotice.learnMore")}
          </a>
        </p>
      </div>
      <div className="mt-5 flex justify-end">
        <Button ref={dismiss} variant="primary" onClick={onClose}>
          {t("loginDisabledNotice.gotIt")}
        </Button>
      </div>
    </dialog>
  );
}
