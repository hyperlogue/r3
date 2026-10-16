import assert from "node:assert/strict";
import { eventually, type openTestBrowser } from "../../scripts/browser.ts";

type Browser = Awaited<ReturnType<typeof openTestBrowser>>;
type Page = Awaited<ReturnType<Browser["attach"]>>;

// DevTools can inspect the product runtime's closed shadow root without
// changing its mode or injecting substitute annotation controls.
export async function componentFrames(
  browser: Browser,
  page: Page,
  count = 1,
  selector = "#component-action",
): Promise<Page[]> {
  const frames = new Map<string, Page>();
  return eventually(async () => {
    const found: Page[] = [];
    for (const target of (await browser.send("Target.getTargets")).targetInfos) {
      if (target.type !== "iframe" || target.url !== "about:srcdoc") continue;
      try {
        const { backendNodeId } = await page.command("DOM.getFrameOwner", {
          frameId: target.targetId,
        });
        const { node } = await page.command("DOM.describeNode", { backendNodeId });
        if (node.attributes?.includes("inert")) continue;
        if (!frames.has(target.targetId))
          frames.set(target.targetId, await browser.attach(target.targetId));
        const frame = frames.get(target.targetId)!;
        if (
          await frame.evaluate(
            `!!document.querySelector(${JSON.stringify(selector)}) && !!document.querySelector('[data-r3-preview]') && document.readyState === 'complete'`,
          )
        ) {
          await frame.evaluate("document.fonts.ready");
          found.push(frame);
        }
      } catch {
        // Navigation and comparison replace iframe targets during discovery.
        frames.delete(target.targetId);
      }
    }
    return found.length === count ? found : null;
  }, "component documents and native annotation runtime");
}

async function runtimeNode(frame: Page, className: string) {
  const { root } = await frame.command("DOM.getDocument", { depth: -1, pierce: true });
  const find = (node: any): any => {
    const attributes = node.attributes ?? [];
    const at = attributes.indexOf("class");
    if (at >= 0 && attributes[at + 1].split(" ").includes(className)) return node;
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
      const found = find(child);
      if (found) return found;
    }
  };
  const node = find(root);
  if (!node) return null;
  return (await frame.command("DOM.resolveNode", { backendNodeId: node.backendNodeId })).object
    .objectId;
}

export async function annotationState(frame: Page, className: "box" | "marker") {
  const objectId = await runtimeNode(frame, className);
  if (!objectId) return null;
  const { result } = await frame.command("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration:
      "function(){const s=getComputedStyle(this);return {hidden:this.hidden,text:this.textContent,rect:this.getBoundingClientRect().toJSON(),border:s.borderColor,radius:s.borderRadius,background:s.backgroundColor}}",
    returnByValue: true,
  });
  return result.value;
}

export async function clickAnnotation(frame: Page, className: "marker" | "controls") {
  const objectId = await eventually(() => runtimeNode(frame, className), `native ${className}`);
  await frame.command("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration:
      className === "controls"
        ? "function(){this.querySelector('button').click()}"
        : "function(){this.click()}",
  });
}

// Scripted popovers and comparisons restore keyboard focus to a control. Clear
// that transient focus for the still, without changing native review highlights.
export async function clearCaptureFocus(page: Page) {
  await page.evaluate("document.activeElement?.blur?.()");
  await page.evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  assert(
    await page.evaluate("!document.querySelector(':focus-visible')"),
    "temporary keyboard focus must not remain in the story capture",
  );
}
