import type { RenderedLocator } from "../../shared/artifacts.ts";
import type { PreviewBootstrap, PreviewDisplay } from "../../shared/preview-protocol.ts";

// Served before publisher scripts. This function is serialized, so every
// runtime dependency is an argument, a local, or a browser API.
export function installPreviewRuntime(
  config: PreviewBootstrap,
  normalize: (text: string) => string,
): void {
  let display: PreviewDisplay = { commenting: false, targets: [], jump: null };
  let root: HTMLDivElement | null = null;
  let shadow: ShadowRoot;
  let box: HTMLDivElement;
  let controls: HTMLDivElement;
  let markers: HTMLDivElement;
  let marked: { button: HTMLButtonElement; element: Element }[] = [];
  let markersDirty = true;
  let picked: Element | null = null;
  let selectedQuote: string | undefined;
  let selectedRange: Range | null = null;
  let hover: Element | null = null;
  let located: Element | null = null;
  let lastJump = -1;
  let restoringRoute = false;
  let frame = 0;
  let observation: MutationObserver | null = null;
  const path = () =>
    config.presentation === "media"
      ? config.entryPath
      : decodeURIComponent(location.pathname.slice("/files/".length));
  const send = (type: string, values: Record<string, unknown> = {}) =>
    parent.postMessage(
      { type, contextId: config.contextId, path: path(), ...values },
      config.applicationOrigin,
    );
  const isOwned = (element: Element) => element === root || element.getRootNode() === shadow;
  const visible = (element: Element) => {
    if (isOwned(element) || element.closest("script,style,noscript,template,[hidden]"))
      return false;
    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      element.getClientRects().length > 0
    );
  };
  const selector = (element: Element): string => {
    if (element.id) {
      const id = `#${CSS.escape(element.id)}`;
      if (document.querySelectorAll(id).length === 1) return id;
    }
    const parts: string[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      let position = 1;
      for (
        let previous = node.previousElementSibling;
        previous;
        previous = previous.previousElementSibling
      )
        if (previous.tagName === node.tagName) position++;
      parts.unshift(`${CSS.escape(node.localName)}:nth-of-type(${position})`);
    }
    return parts.join(" > ");
  };
  // Only visible text participates. Mapping normalized characters to text nodes
  // lets capture and Locate share exactly the same whitespace rule and preserves
  // repeated-quote context without inventing source offsets.
  const projection = (element: Element) => {
    let text = "";
    const nodes: Text[] = [];
    const offsets: number[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && text.length < 200_000; node = walker.nextNode()) {
      const item = node as Text;
      if (!item.parentElement || !visible(item.parentElement)) continue;
      for (let offset = 0; offset < item.data.length && text.length < 200_000; offset++) {
        const character = /\s/u.test(item.data[offset]) ? " " : item.data[offset];
        if (character === " " && (!text || text.endsWith(" "))) continue;
        text += character;
        nodes.push(item);
        offsets.push(offset);
      }
    }
    return { text: text.trimEnd(), nodes, offsets };
  };
  const matches = (text: string, locator: RenderedLocator): number[] => {
    const quote = normalize(locator.quote ?? "");
    if (!quote) return [];
    const prefix = normalize(locator.prefix ?? "");
    const suffix = normalize(locator.suffix ?? "");
    const found: number[] = [];
    for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + 1)) {
      if (
        (!prefix || normalize(text.slice(0, at)).endsWith(prefix)) &&
        (!suffix || normalize(text.slice(at + quote.length)).startsWith(suffix))
      )
        found.push(at);
      if (found.length > 1) break;
    }
    return found;
  };
  const capture = (element: Element): RenderedLocator => {
    const mapped = projection(element);
    const quote = selectedQuote || mapped.text.slice(0, 16_384);
    let at = quote ? mapped.text.indexOf(quote) : -1;
    if (selectedRange && quote) {
      for (let next = at; next >= 0; next = mapped.text.indexOf(quote, next + 1)) {
        if (selectedRange.isPointInRange(mapped.nodes[next], mapped.offsets[next])) {
          at = next;
          break;
        }
      }
    }
    return {
      selector: selector(element),
      ...(quote
        ? {
            quote,
            ...(at >= 0
              ? {
                  prefix: normalize(mapped.text.slice(Math.max(0, at - 100), at)),
                  suffix: normalize(mapped.text.slice(at + quote.length, at + quote.length + 100)),
                }
              : {}),
          }
        : {}),
      route: location.search + location.hash || "#",
      viewport: { width: innerWidth, height: innerHeight },
    };
  };
  const highlight = (range: Range | null) => {
    if (typeof Highlight === "undefined" || !("highlights" in CSS)) return;
    const registry = CSS.highlights as unknown as {
      set(name: string, value: Highlight): void;
      delete(name: string): void;
    };
    if (range) registry.set("r3-preview-active", new Highlight(range));
    else registry.delete("r3-preview-active");
  };
  const find = (
    locator: RenderedLocator,
  ): { state: "anchored" | "ambiguous" | "unplaced"; element?: Element; range?: Range } => {
    let elements: Element[];
    try {
      elements = [...document.querySelectorAll(locator.selector)].filter(visible);
    } catch {
      return { state: "unplaced" };
    }
    if (elements.length > 1) return { state: "ambiguous" };
    if (!elements.length) return { state: "unplaced" };
    const element = elements[0];
    if (!locator.quote) return { state: "anchored", element };
    const mapped = projection(element);
    const indices = matches(mapped.text, locator);
    if (indices.length !== 1) return { state: indices.length ? "ambiguous" : "unplaced" };
    const start = indices[0];
    const end = start + normalize(locator.quote).length - 1;
    const range = document.createRange();
    range.setStart(mapped.nodes[start], mapped.offsets[start]);
    range.setEnd(mapped.nodes[end], mapped.offsets[end] + 1);
    return { state: "anchored", element, range };
  };
  const paint = () => {
    frame = 0;
    if (!root) return;
    if (markersDirty) {
      markersDirty = false;
      marked = [];
      markers.replaceChildren();
      const counts = new Map<Element, number>();
      for (const target of display.targets) {
        const match = target.locator
          ? find(target.locator)
          : { state: "anchored", element: document.body };
        if (match.state !== "anchored" || !match.element) continue;
        const button = document.createElement("button");
        const count = (counts.get(match.element) ?? 0) + 1;
        counts.set(match.element, count);
        button.className = "marker";
        button.textContent = "●";
        button.title = "Open comment";
        button.setAttribute("aria-label", "Open comment");
        button.style.marginLeft = `${(count - 1) * 24}px`;
        button.onclick = () => send("r3-preview-feedback", { feedbackId: target.feedbackId });
        markers.append(button);
        marked.push({ button, element: match.element });
      }
    }
    for (const { button, element } of marked) {
      const rect = element.getBoundingClientRect();
      button.hidden = !element.isConnected || rect.bottom < 0 || rect.top > innerHeight;
      button.style.left = `${Math.max(0, Math.min(rect.right - 24, innerWidth - 24))}px`;
      button.style.top = `${Math.max(0, rect.top)}px`;
    }
    const element = picked || (display.commenting ? hover : null) || located;
    box.hidden = !element?.isConnected;
    controls.hidden = !picked;
    if (!element?.isConnected) return;
    const rect = element.getBoundingClientRect();
    Object.assign(box.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    Object.assign(controls.style, {
      left: `${Math.max(8, Math.min(rect.left, innerWidth - 300))}px`,
      top: `${Math.max(8, Math.min(rect.bottom + 8, innerHeight - 48))}px`,
    });
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(paint);
  };
  const cancel = () => {
    picked = hover = null;
    selectedQuote = undefined;
    selectedRange = null;
    schedule();
  };
  const locate = () => {
    const jump = display.jump;
    if (!root || !jump || jump.nonce === lastJump) return;
    lastJump = jump.nonce;
    cancel();
    highlight(null);
    if (!jump.locator) {
      located = document.body;
      window.scrollTo(0, 0);
      schedule();
      send("r3-preview-located", { state: "anchored", nonce: jump.nonce });
      return;
    }
    const route = jump.locator.route;
    if (route && route !== (location.search + location.hash || "#")) {
      // Query changes reload the actual published document; hash changes keep
      // normal page behavior. No SPA route or unrecorded document is invented.
      lastJump = -1;
      restoringRoute = true;
      location.href = location.pathname + route;
      return;
    }
    const deadline = performance.now() + 2500;
    const attempt = () => {
      if (display.jump?.nonce !== jump.nonce) return;
      const result = find(jump.locator!);
      if (result.state !== "anchored" && performance.now() < deadline) {
        setTimeout(attempt, 100);
        return;
      }
      located = result.element ?? null;
      highlight(result.range ?? null);
      located?.scrollIntoView({ block: "center", inline: "nearest" });
      schedule();
      send("r3-preview-located", { state: result.state, nonce: jump.nonce });
    };
    setTimeout(attempt, 0);
  };
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.origin !== config.applicationOrigin) return;
    const message = event.data;
    if (message?.type !== "r3-preview-display" || message.contextId !== config.contextId) return;
    display = message.display as PreviewDisplay;
    markersDirty = true;
    if (!display.commenting) cancel();
    locate();
    schedule();
  });
  // Register before publisher scripts so a pick cannot activate their click or
  // pointer handlers. Text selection remains native; only activation is stopped.
  const intercept = (event: Event) => {
    if (!display.commenting || event.composedPath().includes(root!)) return;
    event.stopImmediatePropagation();
    if (event.type !== "pointerdown" && event.type !== "mousedown") event.preventDefault();
  };
  for (const name of [
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "dblclick",
    "submit",
    "contextmenu",
  ])
    window.addEventListener(name, intercept, true);
  window.addEventListener(
    "click",
    (event) => {
      if (event.composedPath().includes(root!)) return;
      const element = event.target instanceof Element ? event.target : null;
      if (!element || !visible(element)) return;
      if (display.commenting) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const selection = getSelection();
        selectedRange =
          selection?.rangeCount && !selection.isCollapsed
            ? selection.getRangeAt(0).cloneRange()
            : null;
        selectedQuote = normalize(selection?.toString() ?? "").slice(0, 16_384) || undefined;
        const ancestor = selectedRange?.commonAncestorContainer;
        picked = ancestor instanceof Element ? ancestor : ancestor?.parentElement || element;
        schedule();
      }
    },
    true,
  );
  window.addEventListener(
    "pointermove",
    (event) => {
      if (
        display.commenting &&
        !picked &&
        event.target instanceof Element &&
        !isOwned(event.target)
      ) {
        hover = event.target;
        schedule();
      }
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (event) => {
      if (!display.commenting || event.composedPath().includes(root!)) return;
      if (event.key === "Escape") {
        cancel();
        event.preventDefault();
        event.stopImmediatePropagation();
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  window.addEventListener("scroll", schedule, true);
  window.addEventListener("resize", schedule);
  window.addEventListener("hashchange", () => {
    send("r3-preview-document");
    if (restoringRoute) {
      restoringRoute = false;
      locate();
    }
  });
  const ready = () => {
    root = document.createElement("div");
    root.dataset.r3Preview = "";
    root.style.cssText =
      "all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important";
    shadow = root.attachShadow({ mode: "closed" });
    shadow.innerHTML =
      '<style>:host{color-scheme:light} .box{position:fixed;box-sizing:border-box;border:2px solid #2563eb;background:#3b82f614;pointer-events:none}.controls{position:fixed;display:flex;gap:4px;padding:4px;border-radius:8px;background:#171717;box-shadow:0 2px 12px #0004;pointer-events:auto;font:13px system-ui}button{font:inherit;border:0;border-radius:4px;padding:8px;color:white;background:#404040;cursor:pointer}button:first-child{background:#2563eb}[hidden]{display:none!important}</style><div class="box" hidden></div><div class="controls" hidden><button>Comment here</button><button>Select parent</button><button>Cancel</button></div>';
    box = shadow.querySelector(".box")!;
    controls = shadow.querySelector(".controls")!;
    markers = document.createElement("div");
    shadow.append(markers);
    const markerStyle = document.createElement("style");
    markerStyle.textContent =
      ".marker{position:fixed;width:24px;height:24px;padding:0;background:#2563eb;color:white;pointer-events:auto;border:1px solid white;border-radius:50%;font:12px system-ui;cursor:pointer}";
    shadow.append(markerStyle);
    const buttons = controls.querySelectorAll("button");
    buttons[0].onclick = () => {
      if (picked) {
        send("r3-preview-target", { locator: capture(picked) });
        cancel();
      }
    };
    buttons[1].onclick = () => {
      if (picked?.parentElement) {
        picked = picked.parentElement;
        selectedQuote = undefined;
        selectedRange = null;
        markersDirty = true;
        schedule();
      }
    };
    buttons[2].onclick = cancel;
    const style = document.createElement("style");
    style.textContent = "::highlight(r3-preview-active){background:#facc1580;color:inherit}";
    document.head.append(style);
    document.documentElement.append(root);
    observation = new MutationObserver((changes) => {
      if (changes.some((change) => change.target !== root && !root!.contains(change.target))) {
        markersDirty = true;
        schedule();
      }
    });
    observation.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    send("r3-preview-document");
    locate();
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
  window.addEventListener("pagehide", () => {
    observation?.disconnect();
    cancelAnimationFrame(frame);
  });
}
