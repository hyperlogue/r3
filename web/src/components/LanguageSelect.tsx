import { localeNames, locales, setLocale, t, useLocale } from "../i18n.ts";

export function LanguageSelect() {
  const locale = useLocale();
  return (
    <label className="flex items-center gap-2 text-xs">
      <span>{t("settings.language")}</span>
      <select
        className="min-w-0 flex-1 rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-xs max-md:text-base dark:border-neutral-700 dark:bg-neutral-900"
        value={locale}
        onChange={(event) => {
          const next = locales.find((item) => item === event.target.value);
          if (next) setLocale(next);
        }}
      >
        {locales.map((item) => (
          <option key={item} value={item} lang={item === "zh-cn" ? "zh-CN" : "en"}>
            {localeNames[item]}
          </option>
        ))}
      </select>
    </label>
  );
}
