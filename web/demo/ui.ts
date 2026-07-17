// A tiny, framework-free chrome for the demo: a "DEMO" badge and a Reset button,
// injected straight into <body> so no shared component has to know the demo
// exists. Reset clears the persisted edits back to the seeded reviews and reloads.

import { resetDemo } from "./store.ts";

export function installDemoChrome(): void {
  const mount = () => {
    if (document.getElementById("r3-demo-chrome")) return;
    const bar = document.createElement("div");
    bar.id = "r3-demo-chrome";
    bar.style.cssText = [
      "position:fixed",
      "right:12px",
      "bottom:12px",
      "z-index:2147483647",
      "display:flex",
      "align-items:center",
      "gap:8px",
      "font:500 12px/1 ui-sans-serif,system-ui,sans-serif",
    ].join(";");

    const badge = document.createElement("span");
    badge.textContent = "DEMO";
    badge.style.cssText = [
      "padding:5px 8px",
      "border-radius:9999px",
      "background:#6366f1",
      "color:#fff",
      "letter-spacing:.06em",
      "box-shadow:0 1px 3px rgba(0,0,0,.25)",
    ].join(";");
    badge.title = "Runs entirely in your browser — no server, data lives in localStorage.";

    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "⟳ Reset";
    reset.style.cssText = [
      "padding:5px 10px",
      "border-radius:9999px",
      "border:1px solid rgba(120,120,130,.5)",
      "background:rgba(255,255,255,.9)",
      "color:#27272a",
      "cursor:pointer",
      "box-shadow:0 1px 3px rgba(0,0,0,.2)",
    ].join(";");
    reset.title = "Discard demo edits and restore the seeded reviews";
    reset.addEventListener("click", () => {
      if (confirm("Reset the demo? This clears any feedback, replies, and edits.")) {
        resetDemo();
        location.href = "/";
      }
    });

    bar.append(badge, reset);
    document.body.appendChild(bar);
  };
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
}
