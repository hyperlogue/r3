import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Trans } from "react-i18next";
import siteEnglish from "../site/locales/en.json";
import siteChinese from "../site/locales/zh-cn.json";
import appEnglish from "../web/src/locales/en.json";
import appChinese from "../web/src/locales/zh-cn.json";
import { createLocalization } from "./i18n.ts";

test("bundled resources fall back to English and keep namespaces and instances isolated", async () => {
  const app = createLocalization(
    "app",
    { empty: "Fallback", missing: "English", label: "App" },
    { empty: "", label: "应用" },
    "zh-cn",
  );
  const site = createLocalization("site", { label: "Website" }, { label: "网站" });
  expect(app.t("empty")).toBe("Fallback");
  expect(app.t("missing")).toBe("English");
  expect(app.t("label")).toBe("应用");
  expect(site.t("label")).toBe("Website");
  await site.changeLanguage("zh-CN");
  await app.changeLanguage("en");
  expect(site.t("label")).toBe("网站");
  expect(app.t("label")).toBe("App");
});

test("messages use i18next interpolation and language-specific plural selection", () => {
  const instance = createLocalization(
    "app",
    {
      items_one: "{{count}} item for {{name}}",
      items_other: "{{count}} items for {{name}}",
    },
    { items_other: "{{name}}：{{count}} 项" },
  );
  expect(instance.t("items", { count: 1, name: "A" })).toBe("1 item for A");
  expect(instance.t("items", { count: 2, name: "A" })).toBe("2 items for A");
  expect(instance.t("items", { lng: "zh-CN", count: 1, name: "$& {count}" })).toBe(
    "$& {count}：1 项",
  );
});

test("Trans preserves supplied components and escapes interpolated authored text", () => {
  const instance = createLocalization(
    "app",
    { command: "Run <code/> for {{name}}." },
    { command: "{{name}}：<code/>" },
    "zh-cn",
  );
  const html = renderToStaticMarkup(
    <Trans
      i18n={instance}
      ns="app"
      i18nKey="command"
      components={{ code: <code>r3 auth create-token</code> }}
      values={{ name: '<img src=x onerror="alert(1)">' }}
    />,
  );
  expect(html).toContain("<code>r3 auth create-token</code>");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
});

function flatten(catalog: Record<string, unknown>, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    Object.entries(catalog).flatMap(([key, value]) => {
      const path = prefix ? `${prefix}.${key}` : key;
      return typeof value === "string"
        ? [[path, value]]
        : Object.entries(flatten(value as Record<string, unknown>, path));
    }),
  );
}

for (const [namespace, english, chinese] of [
  ["app", appEnglish, appChinese],
  ["site", siteEnglish, siteChinese],
] as const) {
  test(`${namespace} catalogs keep stable semantic keys, interpolation names and component tags`, () => {
    const source = flatten(english);
    const translated = flatten(chinese);
    expect(Object.keys(translated).sort()).toEqual(Object.keys(source).sort());
    const tokens = (message: string) =>
      [...new Set(message.match(/\{\{\w+\}\}|<\/?[a-zA-Z]+\b/g))].sort();
    for (const [key, value] of Object.entries(source)) {
      expect(key).toMatch(/^[a-zA-Z][a-zA-Z0-9_.]*$/);
      expect(tokens(translated[key] || value), key).toEqual(tokens(value));
    }
  });
}
