import type { RenderedLocator } from "../../shared/artifacts.ts";
import type {
  PreviewBootstrap,
  PreviewDisplay,
  PreviewViewport,
} from "../../shared/preview-protocol.ts";
import type { PreviewConnection } from "./preview-channel.ts";
import type { composerKeyAction, observeTextSelection } from "./selection-events.ts";

// Served before publisher scripts. This function is serialized, so every
// runtime dependency is an argument, a local, or a browser API.
export function installPreviewRuntime(
  config: PreviewBootstrap,
  normalize: (text: string) => string,
  connection: PreviewConnection,
  observeSelection: typeof observeTextSelection,
  composerKey: typeof composerKeyAction,
): void {
  let display: PreviewDisplay = { commenting: false, targets: [], jump: null };
  let viewport: PreviewViewport | null = null;
  let root: HTMLDivElement | null = null;
  let shadow: ShadowRoot;
  let box: HTMLDivElement;
  let locationBox: HTMLDivElement;
  let locationLabel: HTMLDivElement;
  let controls: HTMLDivElement;
  let markers: HTMLDivElement;
  let selectionAction: HTMLButtonElement;
  let pendingSelection: { locator: RenderedLocator; rect: PreviewViewport } | null = null;
  let pressedSelection: { locator: RenderedLocator; rect: PreviewViewport; quote: boolean } | null =
    null;
  let stopSelection: (() => void) | undefined;
  let marked: { button: HTMLButtonElement; element: Element }[] = [];
  let markersDirty = true;
  let picked: Element | null = null;
  let selectedQuote: string | undefined;
  let selectedRange: Range | null = null;
  let hover: Element | null = null;
  let located: Element | null = null;
  let locatedRange: Range | null = null;
  let locatedAncestor = false;
  let feedbackVisible = false;
  let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
  let locateTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingLocate: { locator: RenderedLocator; nonce: number } | null = null;
  let lastJump = -1;
  let restoringRoute = false;
  let frame = 0;
  let observation: MutationObserver | null = null;
  const shadowRoots = new Set<ShadowRoot>();
  const send = (type: string, values: Record<string, unknown> = {}) =>
    connection.send({ type, ...values });
  const isOwned = (element: Element) => element === root || element.getRootNode() === shadow;
  const eventElement = (event: Event) =>
    event.composedPath().find((item): item is Element => item instanceof Element);
  const parent = (element: Element): Element | null => {
    const scope = element.getRootNode();
    return element.parentElement ?? (scope instanceof ShadowRoot ? scope.host : null);
  };
  const shadowScroll = () => {
    pressedSelection = pendingSelection = null;
    schedule();
  };
  const observeShadow = (scope: ShadowRoot) => {
    if (shadowRoots.has(scope)) return;
    shadowRoots.add(scope);
    observation?.observe(scope, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    // Scroll events inside a shadow root do not reach the document listener.
    scope.addEventListener("scroll", shadowScroll, true);
  };
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
    const scope = element.getRootNode() as Document | ShadowRoot;
    if (element.id) {
      const id = `#${CSS.escape(element.id)}`;
      if (scope.querySelectorAll(id).length === 1) return id;
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
    const shadowHosts: string[] = [];
    for (
      let scope = element.getRootNode();
      scope instanceof ShadowRoot;
      scope = scope.host.getRootNode()
    ) {
      observeShadow(scope);
      shadowHosts.unshift(selector(scope.host));
    }
    const ancestors: NonNullable<RenderedLocator["ancestors"]> = [];
    let depth = shadowHosts.length;
    for (
      let child = element, node = parent(child), steps = 0;
      node && steps < 16;
      child = node, node = parent(node), steps++
    ) {
      if (node === document.body || node === document.documentElement) break;
      if (child.getRootNode() !== node.getRootNode()) depth--;
      const parentSelector = selector(node);
      // Optional fallback evidence must not make an otherwise valid pick fail.
      if (parentSelector.length <= 4096)
        ancestors.push({ selector: parentSelector, shadowDepth: depth });
    }
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
      ...(shadowHosts.length ? { shadowHosts } : {}),
      ...(ancestors.length ? { ancestors } : {}),
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
      let scope: Document | ShadowRoot = document;
      for (const hostSelector of locator.shadowHosts ?? []) {
        const hosts: Element[] = [...scope.querySelectorAll(hostSelector)].filter(
          (host) => !isOwned(host),
        );
        if (hosts.length > 1) return { state: "ambiguous" };
        const next: ShadowRoot | null | undefined = hosts[0]?.shadowRoot;
        if (!next) return { state: "unplaced" };
        observeShadow(next);
        scope = next;
      }
      elements = [...scope.querySelectorAll(locator.selector)].filter(visible);
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
  const findAncestor = (locator: RenderedLocator): Element | null => {
    const hosts = locator.shadowHosts ?? [];
    // The exact element comes first: it can still match after its quote changes.
    // Saved host paths also supply ancestor evidence for older shadow targets.
    const candidates = [
      { selector: locator.selector, shadowDepth: hosts.length },
      ...(locator.ancestors ?? []),
      ...hosts.map((selector, shadowDepth) => ({ selector, shadowDepth })).reverse(),
    ];
    for (const ancestor of candidates) {
      const match = find({
        selector: ancestor.selector,
        shadowHosts: hosts.slice(0, ancestor.shadowDepth),
      });
      if (
        match.state === "anchored" &&
        match.element &&
        match.element !== document.body &&
        match.element !== document.documentElement
      )
        return match.element;
    }
    return null;
  };
  const paint = () => {
    frame = 0;
    if (!root) return;
    // Dynamic pages may finish mounting after the first result. Only relevant
    // DOM changes retry, and user interaction ends this navigation operation.
    if (pendingLocate) {
      const result = find(pendingLocate.locator);
      if (result.state === "anchored") showLocation(result, pendingLocate.nonce);
    }
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
        button.title = display.labels?.openComment ?? "Open comment";
        button.setAttribute("aria-label", display.labels?.openComment ?? "Open comment");
        button.style.marginLeft = `${(count - 1) * 24}px`;
        button.onclick = () => send("r3-preview-threads", { threadId: target.threadId });
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
    const element = picked || (display.commenting ? hover : null);
    box.hidden = !element?.isConnected;
    const bounds = viewport ?? { top: 0, left: 0, right: innerWidth, bottom: innerHeight };
    const showLocated =
      display.highlightLocated !== false && feedbackVisible && located?.isConnected;
    const wholePage = located === document.body || located === document.documentElement;
    const textRect = locatedRange?.getBoundingClientRect();
    const preciseText =
      locatedRange &&
      textRect &&
      locatedRange.toString().length <= 1200 &&
      textRect.height <= Math.min(800, bounds.bottom - bounds.top) * 0.6;
    highlight(showLocated && preciseText ? locatedRange : null);
    // A quote is its own precise area, even when its recorded element is body.
    // Element outlines never tint the page; whole-page anchors use a small label.
    locationBox.hidden = !showLocated || !!preciseText || wholePage;
    locationLabel.hidden = !showLocated || !wholePage || !!preciseText;
    locationLabel.textContent = display.labels?.wholePage ?? "Whole page";
    locationLabel.style.left = `${bounds.left + 12}px`;
    locationLabel.style.top = `${bounds.top + 12}px`;
    if (!locationBox.hidden && located) {
      const rect = textRect ?? located.getBoundingClientRect();
      locationBox.dataset.fallback = locatedAncestor ? "ancestor" : "exact";
      locationBox.dataset.large = String(
        rect.width > (bounds.right - bounds.left) * 0.85 &&
          rect.height > (bounds.bottom - bounds.top) * 0.6,
      );
      Object.assign(locationBox.style, {
        left: `${Math.max(bounds.left, rect.left)}px`,
        top: `${Math.max(bounds.top, rect.top)}px`,
        width: `${Math.max(0, Math.min(bounds.right, rect.right) - Math.max(bounds.left, rect.left))}px`,
        height: `${Math.max(0, Math.min(bounds.bottom, rect.bottom) - Math.max(bounds.top, rect.top))}px`,
      });
    }
    controls.hidden = !picked || bounds.bottom <= bounds.top || bounds.right <= bounds.left;
    selectionAction.hidden =
      !pendingSelection || bounds.bottom <= bounds.top || bounds.right <= bounds.left;
    selectionAction.textContent = display.noteHasText
      ? (display.labels?.quoteInNote ?? "Quote in note")
      : (display.labels?.addComment ?? "Add comment");
    const buttons = controls.querySelectorAll("button");
    buttons[0].textContent = display.labels?.commentHere ?? "Comment here";
    buttons[0].title = display.labels?.commentHereHint ?? "Comment here (Space)";
    buttons[1].textContent = display.labels?.selectParent ?? "Select parent";
    buttons[2].textContent = display.labels?.cancel ?? "Cancel";
    if (pendingSelection) {
      const rect = pendingSelection.rect;
      selectionAction.style.maxWidth = `${Math.max(0, bounds.right - bounds.left - 16)}px`;
      Object.assign(selectionAction.style, {
        left: `${Math.max(bounds.left + 8, Math.min((rect.left + rect.right - selectionAction.offsetWidth) / 2, bounds.right - selectionAction.offsetWidth - 8))}px`,
        top: `${Math.max(bounds.top + 8, Math.min(rect.bottom + 8, bounds.bottom - selectionAction.offsetHeight - 8))}px`,
      });
    }
    if (!element?.isConnected) return;
    const rect = element.getBoundingClientRect();
    Object.assign(box.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
    controls.style.maxWidth = `${Math.max(0, bounds.right - bounds.left - 16)}px`;
    Object.assign(controls.style, {
      left: `${Math.max(bounds.left + 8, Math.min(rect.left, bounds.right - controls.offsetWidth - 8))}px`,
      top: `${Math.max(bounds.top + 8, Math.min(rect.bottom + 8, bounds.bottom - controls.offsetHeight - 8))}px`,
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
  const commentHere = () => {
    if (!picked?.isConnected) return;
    send("r3-preview-target", { locator: capture(picked) });
    cancel();
  };
  const stopLocating = () => {
    pendingLocate = null;
    clearTimeout(locateTimer);
  };
  const dismissLocation = () => {
    stopLocating();
    if (display.highlightLocated !== undefined) return;
    clearTimeout(feedbackTimer);
    feedbackVisible = false;
    highlight(null);
    schedule();
  };
  const showLocation = (
    result: ReturnType<typeof find> & { ancestor?: Element | null },
    nonce: number,
  ) => {
    if (result.state === "anchored") stopLocating();
    located = result.ancestor ?? result.element ?? null;
    locatedRange = result.ancestor ? null : (result.range ?? null);
    locatedAncestor = !!result.ancestor;
    feedbackVisible = !!located;
    clearTimeout(feedbackTimer);
    // Scroll the quote's text container rather than a potentially page-sized
    // recorded element. Native scrolling also reaches the outer Markdown pane.
    const destination = locatedRange?.startContainer.parentElement ?? located;
    destination?.scrollIntoView({
      block:
        destination === document.body || destination === document.documentElement
          ? "start"
          : "center",
      inline: "nearest",
      behavior: "instant",
    });
    if (locatedRange) {
      // A paragraph (or body) can be much taller than its scroller. Align the
      // actual quote through nested scrollers after native ancestor navigation.
      for (let node = destination; node && node !== document.body; node = parent(node)) {
        const style = getComputedStyle(node);
        if (
          style.overflowY === "visible" ||
          style.overflowY === "clip" ||
          node.scrollHeight <= node.clientHeight
        )
          continue;
        const text = locatedRange.getBoundingClientRect();
        node.scrollBy({
          top:
            text.top -
            node.getBoundingClientRect().top -
            node.clientTop -
            Math.max(0, (node.clientHeight - text.height) / 2),
          behavior: "instant",
        });
      }
      const text = locatedRange.getBoundingClientRect();
      window.scrollBy({
        top: text.top - Math.max(0, (innerHeight - text.height) / 2),
        behavior: "instant",
      });
    }
    if (display.highlightLocated === undefined)
      feedbackTimer = setTimeout(() => {
        feedbackVisible = false;
        highlight(null);
        schedule();
      }, 2000);
    schedule();
    send("r3-preview-located", {
      state: result.ancestor ? "ancestor" : result.state,
      nonce,
      // A full-height Markdown iframe cannot scroll itself. Its verified parent
      // completes quote alignment in the surrounding file stack.
      ...(locatedRange ? { rect: locatedRange.getBoundingClientRect().toJSON() } : {}),
    });
  };
  const locate = () => {
    const jump = display.jump;
    if (!root || !jump || jump.nonce === lastJump) return;
    lastJump = jump.nonce;
    stopLocating();
    clearTimeout(feedbackTimer);
    cancel();
    located = null;
    locatedRange = null;
    locatedAncestor = false;
    feedbackVisible = false;
    highlight(null);
    if (!jump.locator) {
      showLocation({ state: "anchored", element: document.body }, jump.nonce);
      return;
    }
    const route = jump.locator.route;
    if (route && route !== (location.search + location.hash || "#")) {
      // Query changes reload the actual published document; hash changes keep
      // normal page behavior. No SPA route or unrecorded document is invented.
      lastJump = -1;
      restoringRoute = true;
      if (display.replaceLocateRoute) location.replace(location.pathname + route);
      else location.href = location.pathname + route;
      return;
    }
    const result = find(jump.locator);
    const ancestor = result.state === "unplaced" ? findAncestor(jump.locator) : null;
    showLocation({ ...result, ancestor }, jump.nonce);
    if (result.state !== "anchored") {
      pendingLocate = { locator: jump.locator, nonce: jump.nonce };
      locateTimer = setTimeout(stopLocating, 2500);
    }
  };
  connection.subscribe((message) => {
    if (message?.type === "r3-preview-dismiss-locate" && message.contextId === config.contextId) {
      dismissLocation();
      return;
    }
    if (message?.type === "r3-preview-viewport" && message.contextId === config.contextId) {
      if (viewport && JSON.stringify(viewport) !== JSON.stringify(message.viewport))
        pendingSelection = null;
      viewport = message.viewport;
      schedule();
      return;
    }
    if (message?.type !== "r3-preview-display" || message.contextId !== config.contextId) return;
    display = message.display as PreviewDisplay;
    markersDirty = true;
    if (!display.jump) {
      stopLocating();
      clearTimeout(feedbackTimer);
      feedbackVisible = false;
    }
    if (!display.commenting) cancel();
    locate();
    schedule();
  });
  for (const name of ["pointerdown", "wheel", "keydown"])
    window.addEventListener(name, dismissLocation, { capture: true, passive: true });
  stopSelection = observeSelection(
    (range, touch) => {
      if (!root || config.presentation !== "document") return false;
      const node = range.commonAncestorContainer;
      const element = node instanceof Element ? node : node.parentElement;
      if (!element || !visible(element)) return false;
      selectedRange = range.cloneRange();
      selectedQuote = normalize(range.toString()).slice(0, 16_384);
      const locator = capture(element);
      const { top, right, bottom, left } = range.getBoundingClientRect();
      const selection = { locator, rect: { top, right, bottom, left } };
      cancel();
      if (touch || display.noteHasText) pendingSelection = selection;
      else {
        pendingSelection = null;
        send("r3-preview-selection", { ...selection, quote: false });
      }
      schedule();
      return true;
    },
    () => {
      if (!pressedSelection) pendingSelection = null;
      schedule();
    },
  );
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
      const element = eventElement(event);
      if (!element || !visible(element)) return;
      if (display.commenting) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const selection = getSelection();
        if (selection?.rangeCount && !selection.isCollapsed && normalize(selection.toString()))
          return;
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
      if (event.composedPath().includes(root!)) return;
      const element = eventElement(event);
      if (display.commenting && !picked && element && !isOwned(element)) {
        for (const item of event.composedPath())
          if (item instanceof ShadowRoot) observeShadow(item);
        hover = element;
        schedule();
      }
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.composedPath().includes(root!)) return;
      let active = document.activeElement;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
      const shortcut =
        config.presentation === "document" &&
        event.isTrusted &&
        !event.defaultPrevented &&
        !event.isComposing &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        !active?.matches("input,textarea,select") &&
        !(active instanceof HTMLElement && active.isContentEditable);
      if (shortcut && event.key === "c") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) send("r3-preview-toggle-commenting");
        return;
      }
      // A picked node owns Space before an existing composer's focus shortcut.
      if (shortcut && display.commenting && picked && event.key === " ") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) commentHere();
        return;
      }
      const action = composerKey(event);
      if (
        config.presentation === "document" &&
        event.isTrusted &&
        display.composerVisible &&
        action
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        send("r3-preview-composer-key", { action });
        if (action === "escape") {
          pressedSelection = pendingSelection = null;
          cancel();
        }
        return;
      }
      if (!display.commenting) return;
      if (event.key === "Escape") {
        pressedSelection = pendingSelection = null;
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
  window.addEventListener(
    "scroll",
    () => {
      pressedSelection = pendingSelection = null;
      schedule();
    },
    true,
  );
  window.addEventListener("resize", schedule);
  window.addEventListener("hashchange", () => {
    send("r3-preview-document", { route: location.search + location.hash || "#" });
    if (restoringRoute) {
      restoringRoute = false;
      locate();
    } else dismissLocation();
  });
  const ready = () => {
    root = document.createElement("div");
    root.dataset.r3Preview = "";
    root.style.cssText =
      "all:initial!important;position:fixed!important;inset:0!important;pointer-events:none!important;z-index:2147483647!important";
    shadow = root.attachShadow({ mode: "closed" });
    shadow.innerHTML =
      '<style>:host{color-scheme:light} .box{position:fixed;box-sizing:border-box;border:2px solid #2563eb;background:#3b82f614;pointer-events:none}.controls{position:fixed;display:flex;flex-wrap:wrap;gap:4px;padding:4px;border-radius:8px;background:#171717;border:1px solid #525252;box-shadow:inset 0 1px 0 #ffffff1a,0 2px 4px #0006,0 8px 24px #0008;pointer-events:auto;font:13px system-ui}button{font:inherit;border:0;border-radius:4px;padding:8px;color:white;background:#404040;cursor:pointer}button:first-child{background:#2563eb}[hidden]{display:none!important}</style><div class="box" hidden></div><div class="controls" hidden><button>Comment here</button><button>Select parent</button><button>Cancel</button></div>';
    box = shadow.querySelector(".box")!;
    locationBox = document.createElement("div");
    locationBox.className = "location";
    locationBox.hidden = true;
    locationLabel = document.createElement("div");
    locationLabel.className = "location-label";
    locationLabel.hidden = true;
    locationLabel.setAttribute("role", "status");
    shadow.append(locationBox, locationLabel);
    controls = shadow.querySelector(".controls")!;
    selectionAction = document.createElement("button");
    selectionAction.hidden = true;
    selectionAction.style.cssText =
      "position:fixed;pointer-events:auto;border:1px solid #525252;border-radius:6px;background:#262626;color:white;padding:8px 12px;box-shadow:0 4px 12px #0006;font:13px system-ui;white-space:nowrap";
    selectionAction.onpointerdown = (event) => {
      if (pendingSelection)
        pressedSelection = { ...pendingSelection, quote: !!display.noteHasText };
      event.preventDefault();
    };
    selectionAction.onpointercancel = () => {
      pressedSelection = pendingSelection = null;
      schedule();
    };
    selectionAction.onclick = () => {
      const selected =
        pressedSelection ??
        (pendingSelection && { ...pendingSelection, quote: !!display.noteHasText });
      if (!selected) return;
      send("r3-preview-selection", selected);
      if (selected.quote) getSelection()?.removeAllRanges();
      pressedSelection = pendingSelection = null;
      schedule();
    };
    shadow.append(selectionAction);
    markers = document.createElement("div");
    shadow.append(markers);
    const markerStyle = document.createElement("style");
    markerStyle.textContent =
      ".location{position:fixed;box-sizing:border-box;border:2px solid #3b82f6;pointer-events:none}.location[data-fallback=ancestor]{border-style:dashed}.location[data-large=true]{border-width:0 0 0 3px}.location-label{position:fixed;border:1px solid #737373;border-radius:4px;padding:4px 8px;background:#262626;color:white;font:12px system-ui;pointer-events:none}.marker{position:fixed;width:24px;height:24px;padding:0;background:#2563eb;color:white;pointer-events:auto;border:1px solid white;border-radius:50%;font:12px system-ui;cursor:pointer}";
    shadow.append(markerStyle);
    const buttons = controls.querySelectorAll("button");
    buttons[0].title = "Comment here (Space)";
    buttons[0].onclick = commentHere;
    buttons[1].onclick = () => {
      const ancestor = picked && parent(picked);
      if (ancestor) {
        picked = ancestor;
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
    send("r3-preview-document", { route: location.search + location.hash || "#" });
    locate();
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", ready, { once: true });
  else ready();
  window.addEventListener("pagehide", () => {
    stopLocating();
    clearTimeout(feedbackTimer);
    stopSelection?.();
    observation?.disconnect();
    for (const scope of shadowRoots) scope.removeEventListener("scroll", shadowScroll, true);
    shadowRoots.clear();
    cancelAnimationFrame(frame);
  });
}
