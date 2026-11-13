import { expect, test } from "bun:test";
import { previewLinkAction } from "./preview-links.ts";

const app = "https://r3.example";

test("artifact links on the app origin route in place", () => {
  expect(previewLinkAction(`${app}/artifact_Zs-AH?v=2#plan`, false, app, "blocked")).toEqual({
    kind: "route",
    route: "/artifact_Zs-AH?v=2#plan",
  });
  expect(previewLinkAction(`${app}/`, false, app, "blocked")).toEqual({
    kind: "route",
    route: "/",
  });
});

test("links leaving the app origin need confirmation without external network", () => {
  const away = "https://elsewhere.example/artifact_Zs?d=secret";
  for (const network of ["blocked", "compatible"] as const)
    expect(previewLinkAction(away, false, app, network)).toEqual({
      kind: "open",
      href: away,
      confirm: true,
    });
  expect(previewLinkAction(away, false, app, "external")).toEqual({
    kind: "open",
    href: away,
    confirm: false,
  });
});

test("same-origin links in a new tab or outside artifact routes open without confirmation", () => {
  for (const [href, newTab] of [
    [`${app}/artifact_Zs`, true],
    [`${app}/api/artifacts`, false],
  ] as const)
    expect(previewLinkAction(href, newTab, app, "blocked")).toEqual({
      kind: "open",
      href,
      confirm: false,
    });
});

test("non-web or malformed links are ignored", () => {
  for (const href of ["javascript:alert(1)", "data:text/html,x", "not a url", 7, "x".repeat(9000)])
    expect(previewLinkAction(href, false, app, "external")).toBeNull();
});
