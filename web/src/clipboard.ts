// Copy text to the clipboard, working outside secure contexts too. The daemon
// can bind to a remote host, where the page is served over plain
// HTTP and `navigator.clipboard` is undefined — so fall back to a hidden
// <textarea> + execCommand("copy"). Never throws; resolves to whether the copy
// actually landed, so callers can show a failure state.
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied / not focused — fall through to the legacy path.
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    // Off-screen but still focusable/selectable; readonly avoids a mobile keyboard.
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
