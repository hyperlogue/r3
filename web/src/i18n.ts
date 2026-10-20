import { useSyncExternalStore } from "react";
import {
  chooseLocale,
  type Locale,
  languageTags,
  type MessageValues,
  matchLocale,
  translate,
} from "../../shared/locale.ts";
import { readDisplayPreference, writeDisplayPreference } from "./display-storage.ts";
import english from "./locales/en.json";
import chinese from "./locales/zh-cn.json";

export { type Locale, languageTags, localeNames, locales } from "../../shared/locale.ts";

const storageKey = "r3-locale";
const browserLanguages = () =>
  typeof navigator === "undefined" ? [] : (navigator.languages ?? []);
const requested =
  typeof location === "undefined" ? null : new URLSearchParams(location.search).get("lang");
let locale = chooseLocale(
  matchLocale(requested) ?? readDisplayPreference(storageKey),
  browserLanguages(),
);
const listeners = new Set<() => void>();
let initialized = false;
export const getLocale = () => locale;
export const getLanguageTag = () => languageTags[locale];
function update(next: Locale) {
  locale = next;
  if (initialized) {
    document.documentElement.lang = getLanguageTag();
    const url = new URL(location.href);
    if (url.searchParams.has("lang")) {
      url.searchParams.set("lang", next);
      try {
        history.replaceState(history.state, "", url);
      } catch {
        // An opaque example can switch language without changing its URL.
      }
    }
  }
  for (const listener of listeners) listener();
}
export function setLocale(next: Locale) {
  writeDisplayPreference(storageKey, next);
  update(next);
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useLocale() {
  return useSyncExternalStore(subscribe, getLocale, () => "en" as const);
}
export function t(message: string, values?: MessageValues, language = locale): string {
  return translate(language === "zh-cn" ? chinese : english, message, values);
}
export function plural(one: string, other: string, count: number, values?: MessageValues): string {
  const message = new Intl.PluralRules(getLanguageTag()).select(count) === "one" ? one : other;
  return t(message, { ...values, count });
}
// Hosts opt in to document language and browser synchronization. Importing a
// shared control (the website's Logo, for example) must not change its host page.
export function initializeLocale() {
  if (initialized) return;
  initialized = true;
  if (matchLocale(requested)) writeDisplayPreference(storageKey, locale);
  update(locale);
  window.addEventListener("storage", (event) => {
    if (event.key === storageKey || event.key === null)
      update(chooseLocale(event.key === null ? null : event.newValue, browserLanguages()));
  });
}
