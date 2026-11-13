import { getLanguageTag, t } from "./i18n.ts";

export function relativeArtifactTime(value: string, now: number): string {
  const seconds = (Date.parse(value) - now) / 1000;
  if (Math.abs(seconds) < 60) return t("libraryRow.justNow");
  const [scale, unit] =
    Math.abs(seconds) < 3600
      ? ([60, "minute"] as const)
      : Math.abs(seconds) < 86400
        ? ([3600, "hour"] as const)
        : Math.abs(seconds) < 604800
          ? ([86400, "day"] as const)
          : Math.abs(seconds) < 2592000
            ? ([604800, "week"] as const)
            : Math.abs(seconds) < 31536000
              ? ([2592000, "month"] as const)
              : ([31536000, "year"] as const);
  return new Intl.RelativeTimeFormat(getLanguageTag(), { numeric: "auto" }).format(
    Math.trunc(seconds / scale),
    unit,
  );
}
