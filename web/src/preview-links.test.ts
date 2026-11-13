import { expect, test } from "bun:test";
import { previewLinkAction } from "./preview-links.ts";

const app = "https://r3.example";

test("artifact links on the app origin route in place", () => {
  expect(previewLinkAction(`${app}/artifact_Zs-AH?v=2#plan`, false, app)).toEqual({
    kind: "route",
    route: "/artifact_Zs-AH?v=2#plan",
  });
  expect(previewLinkAction(`${app}/`, false, app)).toEqual({ kind: "route", route: "/" });
});

test("other links open a new tab", () => {
  for (const [href, newTab] of [
    [`${app}/artifact_Zs`, true],
    [`${app}/api/artifacts`, false],
    ["https://elsewhere.example/artifact_Zs", false],
  ] as const)
    expect(previewLinkAction(href, newTab, app)).toEqual({ kind: "open", href });
});

test("non-web or malformed links are ignored", () => {
  for (const href of ["javascript:alert(1)", "data:text/html,x", "not a url", 7, "x".repeat(9000)])
    expect(previewLinkAction(href, false, app)).toBeNull();
});
