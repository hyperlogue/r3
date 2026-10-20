// Browser presentation only. Locale never changes protocol values or authored content.
export const locales = ["en", "zh-cn"] as const;
export type Locale = (typeof locales)[number];
export const localeNames: Record<Locale, string> = { en: "English", "zh-cn": "简体中文" };
export const languageTags: Record<Locale, string> = { en: "en", "zh-cn": "zh-CN" };

export function matchLocale(value: string | null | undefined): Locale | null {
  const tag = value?.toLowerCase().replaceAll("_", "-");
  if (tag === "en" || tag?.startsWith("en-")) return "en";
  if (tag === "zh" || tag === "zh-cn" || tag === "zh-sg" || tag?.startsWith("zh-hans"))
    return "zh-cn";
  return null;
}

export function chooseLocale(saved: string | null, languages: readonly string[]): Locale {
  return matchLocale(saved) ?? languages.map(matchLocale).find((value) => value !== null) ?? "en";
}
