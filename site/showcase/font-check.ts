import assert from "node:assert/strict";
import type { openTestBrowser } from "../../scripts/browser.ts";

type Browser = Awaited<ReturnType<typeof openTestBrowser>>;
type Page = Awaited<ReturnType<Browser["attach"]>>;

// A loaded FontFace alone does not prove a control actually uses that font.
export async function verifyWorkspaceFont(page: Page) {
  await page.evaluate("document.fonts.ready");
  await page.command("DOM.enable");
  await page.command("CSS.enable");
  const { root } = await page.command("DOM.getDocument");
  const { nodeIds } = await page.command("DOM.querySelectorAll", {
    nodeId: root.nodeId,
    selector:
      '[aria-label="Latest version"], [data-compare-comment], .fieldwork-body h1, .prompt-document h1',
  });
  let rendered = 0;
  for (const nodeId of nodeIds) {
    const { fonts } = await page.command("CSS.getPlatformFontsForNode", { nodeId });
    // Desktop and mobile headers coexist; hidden copies have no glyphs.
    // The compact phone header hides Latest, so also inspect visible UI text.
    if (!fonts.length) continue;
    rendered++;
    assert(
      fonts.every(
        (font: { familyName: string; isCustomFont: boolean }) =>
          font.familyName === "Roboto" && font.isCustomFont,
      ),
      "Visible workspace text must render with bundled Roboto, not a host fallback",
    );
  }
  assert(rendered > 0, "The captured workspace must contain visible text");
}
