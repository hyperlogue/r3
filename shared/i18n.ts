import { createInstance } from "i18next";
import { type Locale, languageTags } from "./locale.ts";

export function createLocalization(
  namespace: string,
  english: Record<string, unknown>,
  chinese: Record<string, unknown>,
  locale: Locale = "en",
) {
  const instance = createInstance();
  // Bundled resources initialize synchronously and work without a network backend.
  void instance.init({
    initAsync: false,
    lng: languageTags[locale],
    supportedLngs: ["en", "zh-CN"],
    load: "currentOnly",
    fallbackLng: "en",
    ns: [namespace],
    defaultNS: namespace,
    resources: { en: { [namespace]: english }, "zh-CN": { [namespace]: chinese } },
    returnEmptyString: false,
    returnNull: false,
    interpolation: { escapeValue: false },
    react: { useSuspense: false, transSupportBasicHtmlNodes: false },
  });
  return instance;
}

export type MessageKey<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K extends `${infer Base}_one` | `${infer Base}_other`
      ? Base
      : K
    : `${K}.${MessageKey<T[K]>}`;
}[keyof T & string];
