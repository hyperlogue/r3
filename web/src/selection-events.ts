// Shared by the workspace and the opaque preview. Serialized into the preview
// runtime: keep dependencies inside the function or pass them explicitly.
export function observeTextSelection(
  select: (range: Range, touch: boolean) => boolean,
  dismiss: () => void,
  coarse: () => boolean = () => matchMedia("(pointer: coarse)").matches,
): () => void {
  let timer = 0;
  let dragging = false;
  let keyboard = false;
  let previous: Range | null = null;
  const element = (node: Node) => (node instanceof Element ? node : node.parentElement);
  const excluded = (node: Node) => {
    const el = element(node);
    return (
      !!el?.closest("input,textarea,select,[data-gutter],[inert]") ||
      (el instanceof HTMLElement && el.isContentEditable)
    );
  };
  const clear = () => {
    clearTimeout(timer);
    keyboard = false;
    dismiss();
  };
  const capture = () => {
    clearTimeout(timer);
    keyboard = false;
    const selection = getSelection();
    if (!selection?.rangeCount || selection.isCollapsed || !selection.toString().trim()) return;
    const range = selection.getRangeAt(0);
    if (excluded(range.startContainer) || excluded(range.endContainer)) return;
    if (
      previous &&
      range.startContainer === previous.startContainer &&
      range.startOffset === previous.startOffset &&
      range.endContainer === previous.endContainer &&
      range.endOffset === previous.endOffset
    )
      return;
    if (select(range, coarse())) previous = range.cloneRange();
  };
  const change = () => {
    clearTimeout(timer);
    if (getSelection()?.isCollapsed) {
      previous = null;
      dismiss();
    } else if (!dragging && (coarse() || keyboard)) timer = window.setTimeout(capture, 275);
  };
  const down = () => {
    dragging = true;
    keyboard = false;
    clearTimeout(timer);
  };
  const up = (event: MouseEvent) => {
    dragging = false;
    if (event.button !== 0 || (event.target instanceof Node && excluded(event.target))) return;
    if (coarse()) change();
    else capture();
  };
  const release = () => {
    dragging = false;
    if (coarse()) change();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") clear();
    if (
      !event.isComposing &&
      !event.defaultPrevented &&
      ((event.shiftKey && /^(Arrow|Home|End|Page)/.test(event.key)) ||
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a"))
    )
      keyboard = true;
  };
  // Document-wide release includes drags ending over the feedback panel.
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("mouseup", up, true);
  window.addEventListener("pointerup", release, true);
  window.addEventListener("pointercancel", clear, true);
  window.addEventListener("keydown", key, true);
  document.addEventListener("selectionchange", change);
  document.addEventListener("scroll", clear, true);
  window.addEventListener("hashchange", clear);
  window.addEventListener("pagehide", clear);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("pointerdown", down, true);
    window.removeEventListener("mouseup", up, true);
    window.removeEventListener("pointerup", release, true);
    window.removeEventListener("pointercancel", clear, true);
    window.removeEventListener("keydown", key, true);
    document.removeEventListener("selectionchange", change);
    document.removeEventListener("scroll", clear, true);
    window.removeEventListener("hashchange", clear);
    window.removeEventListener("pagehide", clear);
  };
}

// Also serialized into previews. Pointer-stranded button focus must not steal
// Space, but a visible keyboard focus ring and native text entry keep their keys.
export function composerKeyAction(event: KeyboardEvent): "focus" | "escape" | null {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.repeat ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  )
    return null;
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    if (active.matches("input,textarea,select") || active.isContentEditable) return null;
    const interactive = active.matches('button,a,[role="button"]');
    if (interactive && (event.key === "Escape" || active.matches(":focus-visible"))) return null;
  }
  return event.key === " " || event.key === "Tab"
    ? "focus"
    : event.key === "Escape"
      ? "escape"
      : null;
}
