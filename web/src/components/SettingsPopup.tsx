import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, TOKEN } from "../api.ts";
import { useTheme } from "../hooks.ts";
import {
  FONT_MAX,
  FONT_MIN,
  SYNTAX_THEMES,
  setFontSize,
  setSyntaxTheme,
  useFontSize,
  useSyntaxTheme,
} from "../settings.ts";
import type { ThemeOption } from "../types.ts";
import { Button, cn, useEscape } from "../ui.tsx";
import { TokenManager } from "./TokenManager.tsx";

// Group theme options by their `group` field, preserving first-seen order.
function groupThemes(options: ThemeOption[]): { name: string; items: ThemeOption[] }[] {
  const groups: { name: string; items: ThemeOption[] }[] = [];
  for (const o of options) {
    let g = groups.find((x) => x.name === o.group);
    if (!g) {
      g = { name: o.group, items: [] };
      groups.push(g);
    }
    g.items.push(o);
  }
  return groups;
}

// Until /api/themes loads, show the curated families so the picker isn't empty.
const FALLBACK_THEMES: ThemeOption[] = SYNTAX_THEMES.map((t) => ({
  id: t.id,
  label: t.label,
  group: "Auto (light + dark)",
}));

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-3 py-2.5">
      <div className="mb-1.5 text-[0.625rem] font-semibold uppercase tracking-wider text-neutral-400">
        {label}
      </div>
      {children}
    </div>
  );
}

// A −/+ font-size stepper: one square button, differing only in delta, bound, and
// glyph.
function StepButton({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-neutral-300 text-sm disabled:opacity-30 dark:border-neutral-700"
    >
      {label}
    </button>
  );
}

// A two-option segmented control.
function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex rounded-md border border-neutral-300 p-0.5 dark:border-neutral-700">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={cn(
            "flex-1 rounded px-2 py-1 text-xs font-medium transition-colors",
            value === o.id
              ? "bg-neutral-200 text-neutral-900 dark:bg-neutral-700 dark:text-neutral-100"
              : "text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function SettingsPopup() {
  const [open, setOpen] = useState(false);
  const [dark, toggleTheme] = useTheme();
  const fontSize = useFontSize();
  const syntaxTheme = useSyntaxTheme();
  const { data: themes } = useQuery({
    queryKey: ["themes"],
    queryFn: () => api.themes(),
    staleTime: Number.POSITIVE_INFINITY, // the theme list is static for a daemon build
  });
  const themeGroups = groupThemes(themes ?? FALLBACK_THEMES);

  useEscape(open, () => setOpen(false));

  return (
    <div className="relative self-stretch">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Settings"
        className={cn(
          "flex h-full cursor-pointer items-center justify-center pr-4 transition-colors",
          open
            ? "text-neutral-900 dark:text-neutral-100"
            : "text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100",
        )}
      >
        <svg
          className="size-5"
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>

      {open && (
        <>
          {/* click-catcher: closes the popup when clicking elsewhere */}
          <button
            type="button"
            aria-label="Close settings"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          {/* Anchor the popup's right edge under the gear icon (right-4 = the
              button's pr-4 gutter) rather than flush to the viewport, and cap the
              width so a narrow window can never push it off the right edge. */}
          <div className="absolute right-4 top-full z-50 mt-1.5 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-neutral-300 bg-white shadow-xl dark:border-neutral-700 dark:bg-neutral-950">
            <div className="border-b border-neutral-300 px-3 py-2 text-xs font-semibold dark:border-neutral-700">
              Settings
            </div>

            <Section label="Appearance">
              <Segmented
                options={[
                  { id: "light", label: "☀ Light" },
                  { id: "dark", label: "☾ Dark" },
                ]}
                value={dark ? "dark" : "light"}
                onChange={(id) => {
                  if ((id === "dark") !== dark) toggleTheme();
                }}
              />
            </Section>

            <Section label={`Font size · ${fontSize}px`}>
              <div className="flex items-center gap-2">
                <StepButton
                  onClick={() => setFontSize(fontSize - 1)}
                  disabled={fontSize <= FONT_MIN}
                  label="−"
                />
                <input
                  type="range"
                  min={FONT_MIN}
                  max={FONT_MAX}
                  value={fontSize}
                  onChange={(e) => setFontSize(Number(e.target.value))}
                  className="h-1 min-w-0 flex-1 accent-primary-600"
                />
                <StepButton
                  onClick={() => setFontSize(fontSize + 1)}
                  disabled={fontSize >= FONT_MAX}
                  label="+"
                />
              </div>
            </Section>

            <Section label="Syntax theme">
              <select
                value={syntaxTheme}
                onChange={(e) => setSyntaxTheme(e.target.value)}
                // max-md:text-base — iOS zooms on focusing a <select> under 16px
                // too, same as text inputs.
                className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-xs text-neutral-700 outline-none focus:border-primary-400 max-md:text-base dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
              >
                {themeGroups.map((g) => (
                  <optgroup key={g.name} label={g.name}>
                    {g.items.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <p className="mt-1.5 text-[0.625rem] text-neutral-400">
                “Auto” themes follow light/dark mode; the rest apply as-is.
              </p>
            </Section>

            {/* Login tokens for reaching r3 when it's exposed beyond loopback. */}
            <Section label="Access">
              <TokenManager />
            </Section>

            {/* Sign out — only an exposed (cookie) session can; a non-exposed one
                holds the token (TOKEN != "") and has nothing to sign out of. */}
            {TOKEN === "" && (
              <Section label="Session">
                <Button
                  variant="default"
                  onClick={() => api.logout().finally(() => location.reload())}
                  className="w-full justify-center"
                >
                  Sign out
                </Button>
              </Section>
            )}
          </div>
        </>
      )}
    </div>
  );
}
