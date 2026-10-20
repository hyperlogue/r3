import type { TOptions } from "i18next";
import { useTranslation as useReactTranslation } from "react-i18next";
import { createLocalization, type MessageKey } from "../../shared/i18n.ts";
import { chooseLocale, type Locale, languageTags, matchLocale } from "../../shared/locale.ts";
import { readDisplayPreference, writeDisplayPreference } from "./display-storage.ts";
import english from "./locales/en.json";
import chinese from "./locales/zh-cn.json";

export { type Locale, languageTags, localeNames, locales } from "../../shared/locale.ts";
export type AppMessageKey = MessageKey<typeof english>;
const storageKey = "r3-locale";
const browserLanguages = () =>
  typeof navigator === "undefined" ? [] : (navigator.languages ?? []);
const requested =
  typeof location === "undefined" ? null : new URLSearchParams(location.search).get("lang");
const initialLocale = chooseLocale(
  matchLocale(requested) ?? readDisplayPreference(storageKey),
  browserLanguages(),
);
export const appI18n = createLocalization("app", english, chinese, initialLocale);
export const getLocale = (): Locale =>
  matchLocale(appI18n.resolvedLanguage ?? appI18n.language) ?? "en";
export const getLanguageTag = () => languageTags[getLocale()];
export const t = appI18n.getFixedT(null, "app") as (
  key: AppMessageKey,
  options?: TOptions,
) => string;
export function useTranslation() {
  const result = useReactTranslation("app", { i18n: appI18n });
  return { ...result, t: result.t as typeof t };
}
export function useLocale(): Locale {
  const { i18n } = useTranslation();
  return matchLocale(i18n.resolvedLanguage ?? i18n.language) ?? "en";
}
export function setLocale(next: Locale) {
  writeDisplayPreference(storageKey, next);
  void appI18n.changeLanguage(languageTags[next]);
}
let initialized = false;
function updateDocument() {
  document.documentElement.lang = getLanguageTag();
  const url = new URL(location.href);
  if (url.searchParams.has("lang")) {
    url.searchParams.set("lang", getLocale());
    try {
      history.replaceState(history.state, "", url);
    } catch {
      /* Opaque examples keep their URL. */
    }
  }
}
// Shared controls do not take ownership of their host's document language.
export function initializeLocale() {
  if (initialized) return;
  initialized = true;
  if (matchLocale(requested)) writeDisplayPreference(storageKey, getLocale());
  updateDocument();
  appI18n.on("languageChanged", updateDocument);
  window.addEventListener("storage", (event) => {
    if (event.key === storageKey || event.key === null)
      void appI18n.changeLanguage(
        languageTags[chooseLocale(event.key === null ? null : event.newValue, browserLanguages())],
      );
  });
}
