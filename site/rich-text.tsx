import { renderToStaticMarkup } from "react-dom/server";
import { Trans } from "react-i18next";
import { type Locale, languageTags, type SiteMessageKey, siteI18n } from "./i18n.ts";

// Translators may reorder named links; destinations stay in the template.
export function richText(key: SiteMessageKey, locale: Locale, links: Record<string, string>) {
  return renderToStaticMarkup(
    <Trans
      i18n={siteI18n}
      t={siteI18n.getFixedT(languageTags[locale], "site")}
      ns="site"
      i18nKey={String(key)}
      components={Object.fromEntries(
        Object.entries(links).map(([name, href]) => [
          name,
          <a key={name} href={href}>
            {name}
          </a>,
        ]),
      )}
    />,
  );
}
