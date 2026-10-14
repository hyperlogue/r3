export function startPreviewTilt(frame: HTMLElement) {
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  // Measure the stationary parent so tilting never changes pointer coordinates.
  const surface = frame.parentElement!;
  let pending = 0;
  const reset = () => {
    cancelAnimationFrame(pending);
    frame.style.removeProperty("--tilt-x");
    frame.style.removeProperty("--tilt-y");
    delete frame.dataset.hovered;
  };
  surface.addEventListener("pointermove", (event) => {
    if (motion.matches || event.pointerType !== "mouse") return;
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      const rect = surface.getBoundingClientRect();
      const x = Math.max(-0.5, Math.min(0.5, (event.clientX - rect.left) / rect.width - 0.5));
      const y = Math.max(-0.5, Math.min(0.5, (event.clientY - rect.top) / rect.height - 0.5));
      frame.style.setProperty("--tilt-x", `${-y * 8}deg`);
      frame.style.setProperty("--tilt-y", `${x * 12}deg`);
      frame.dataset.hovered = "true";
    });
  });
  surface.addEventListener("pointerleave", reset);
  surface.addEventListener("pointercancel", reset);
  motion.addEventListener("change", reset);
  window.addEventListener("pagehide", reset);
}
