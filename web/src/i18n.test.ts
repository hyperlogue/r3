import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { chooseLocale, interpolate, matchLocale, translate } from "../../shared/locale.ts";
import english from "./locales/en.json";
import chinese from "./locales/zh-cn.json";

test("locale matching respects explicit choice and Simplified Chinese language preferences", () => {
  expect(chooseLocale("en", ["zh-CN"])).toBe("en");
  expect(chooseLocale(null, ["fr-FR", "zh-Hans-SG", "en-US"])).toBe("zh-cn");
  expect(chooseLocale("invalid", ["en-GB"])).toBe("en");
  expect(chooseLocale(null, ["zh-TW", "zh-Hant"])).toBe("en");
  expect(matchLocale("zh_CN")).toBe("zh-cn");
  expect(matchLocale("zh-CN-untrusted")).toBeNull();
});

test("messages support reordered placeholders and safe literal interpolation with fallback", () => {
  const message = "{name}: {count}";
  expect(
    translate({ [message]: "{count} — {name}" }, message, { count: 0, name: "$& {count}" }),
  ).toBe("0 — $& {count}");
  expect(translate({ [message]: "" }, message, { name: "A", count: 2 })).toBe("A: 2");
  expect(interpolate("{missing}", {})).toBe("{missing}");
  expect(translate({}, "constructor")).toBe("constructor");
});

test("catalogs have the same keys and retain every named placeholder", () => {
  expect(Object.keys(chinese).sort()).toEqual(Object.keys(english).sort());
  for (const [key, value] of Object.entries(chinese)) {
    const placeholders = (text: string) => [...new Set(text.match(/\{\w+\}/g))].sort();
    expect(placeholders(value || key)).toEqual(placeholders(key));
  }
});

test("browser localization can be imported by server preview support without browser globals", async () => {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "-e", 'await import("./web/src/i18n.ts")'],
    { cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  );
  const error = await new Response(child.stderr).text();
  expect(await child.exited, error).toBe(0);
});
