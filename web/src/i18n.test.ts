import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { chooseLocale, matchLocale } from "../../shared/locale.ts";

test("locale matching respects explicit choice and Simplified Chinese language preferences", () => {
  expect(chooseLocale("en", ["zh-CN"])).toBe("en");
  expect(chooseLocale(null, ["fr-FR", "zh-Hans-SG", "en-US"])).toBe("zh-cn");
  expect(chooseLocale("invalid", ["en-GB"])).toBe("en");
  expect(chooseLocale(null, ["zh-TW", "zh-Hant"])).toBe("en");
  expect(matchLocale("zh_CN")).toBe("zh-cn");
  expect(matchLocale("zh-CN-untrusted")).toBeNull();
});

test("browser localization can be imported by server preview support without browser globals", async () => {
  const child = Bun.spawn(
    [process.execPath, "--no-env-file", "-e", 'await import("./web/src/i18n.ts")'],
    { cwd: resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  );
  const error = await new Response(child.stderr).text();
  expect(await child.exited, error).toBe(0);
});
