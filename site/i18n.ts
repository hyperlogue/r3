import { type Locale, type MessageValues, translate } from "../shared/locale.ts";
import english from "./locales/en.json";
import chinese from "./locales/zh-cn.json";

export { type Locale, languageTags, localeNames, locales } from "../shared/locale.ts";
export function siteLocale(): Locale {
  return typeof document !== "undefined" && document.documentElement.lang === "zh-CN"
    ? "zh-cn"
    : "en";
}
export function t(message: string, values?: MessageValues, locale = siteLocale()): string {
  return translate(locale === "zh-cn" ? chinese : english, message, values);
}
export function localePath(path: string, locale: Locale): string {
  if (locale === "en" || !path.startsWith("/") || path.startsWith("//")) return path;
  if (/^\/(?:assets|pagefind|demo|example)(?:\/|$)/.test(path)) return path;
  if (path === "/zh-cn" || path.startsWith("/zh-cn/")) return path;
  return `/zh-cn${path}`;
}
