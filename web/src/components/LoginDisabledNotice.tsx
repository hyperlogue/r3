import { useId, useLayoutEffect, useRef, useState } from "react";
import { Trans } from "react-i18next";
import { LOGIN_NOTICE } from "../api.ts";
import { copyText } from "../clipboard.ts";
import { readDisplayPreference, writeDisplayPreference } from "../display-storage.ts";
import { appI18n, getLocale, useTranslation } from "../i18n.ts";
import { suspendKeys } from "../keys.ts";
import { Button, StrokeIcon, useCopyFlash } from "../ui.tsx";

// Seen once per browser and application origin; storage failure only repeats it.
const storageKey = "r3-login-disabled-notice";
const DOCS = "https://hyperlogue.github.io/r3";
const COMMANDS =
  "r3 config set requireLogin true\nr3 server restart\nr3 auth create-token --label browser";

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
  const { copied, flash } = useCopyFlash();
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
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-auto rounded-xl border-2 border-warning-400! bg-white p-5 text-neutral-900 r3-modal backdrop:bg-black/40 dark:border-warning-500/80! dark:bg-neutral-900 dark:text-neutral-100"
    >
      <h2 id={title} className="text-lg font-semibold">
        <Trans
          i18n={appI18n}
          ns="app"
          i18nKey="loginDisabledNotice.title"
          components={{ em: <em className="text-warning-700 dark:text-warning-400" /> }}
        />
      </h2>
      <div
        id={description}
        className="mt-3 space-y-3 text-sm text-neutral-600 dark:text-neutral-300"
      >
        <p>{t("loginDisabledNotice.risk")}</p>
        <p>{t("loginDisabledNotice.enable")}</p>
        <div className="flex items-start gap-2 rounded bg-neutral-100 p-2 dark:bg-neutral-800">
          <pre className="min-w-0 flex-1 whitespace-pre-wrap font-mono text-xs leading-5">
            {COMMANDS}
          </pre>
          <Button
            variant="ghost"
            aria-label={copied ? t("common.commandCopied") : t("loginDisabledNotice.copyCommands")}
            title={copied ? t("common.copied") : t("loginDisabledNotice.copyCommands")}
            onClick={async () => {
              if (await copyText(COMMANDS)) flash();
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
        <span role="status" className="sr-only">
          {copied ? t("common.commandCopied") : ""}
        </span>
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
