import type { TOptions } from "i18next";
import { createLocalization, type MessageKey } from "../shared/i18n.ts";
import { type Locale, languageTags } from "../shared/locale.ts";
import english from "./locales/en.json";
import chinese from "./locales/zh-cn.json";

export { type Locale, languageTags, localeNames, locales } from "../shared/locale.ts";
export type SiteMessageKey = MessageKey<typeof english>;
export const siteI18n = createLocalization("site", english, chinese);
export function siteLocale(): Locale {
  return typeof document !== "undefined" && document.documentElement.lang === "zh-CN"
    ? "zh-cn"
    : "en";
}
export function siteTranslator(locale: Locale) {
  return siteI18n.getFixedT(languageTags[locale], "site") as (
    key: SiteMessageKey,
    options?: TOptions,
  ) => string;
}
export function t(key: SiteMessageKey, options?: TOptions): string {
  return siteTranslator(siteLocale())(key, options);
}
// Template translations are text. Escape only at the HTML output boundary.
export function h(key: SiteMessageKey, locale: Locale, options?: TOptions): string {
  return siteTranslator(locale)(key, options)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
export function localePath(path: string, locale: Locale): string {
  if (locale === "en" || !path.startsWith("/") || path.startsWith("//")) return path;
  if (/^\/(?:assets|pagefind|demo|example)(?:\/|$)/.test(path)) return path;
  if (path === "/zh-cn" || path.startsWith("/zh-cn/")) return path;
  return `/zh-cn${path}`;
}
