import { useEffect, useState } from "react";
import { Button } from "../ui.tsx";
import "./overlay-contrast.css";

export function OverlayContrastPreview() {
  const [stronger, setStronger] = useState(true);
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.getAttribute("data-showcase-contrast");
    root.setAttribute("data-showcase-contrast", stronger ? "stronger" : "current");
    return () => {
      if (previous === null) root.removeAttribute("data-showcase-contrast");
      else root.setAttribute("data-showcase-contrast", previous);
    };
  }, [stronger]);
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-medium">Overlay contrast proposal</span>
        <fieldset aria-label="Overlay contrast" className="flex gap-1">
          <Button aria-pressed={!stronger} onClick={() => setStronger(false)}>
            Current
          </Button>
          <Button aria-pressed={stronger} onClick={() => setStronger(true)}>
            Stronger
          </Button>
        </fieldset>
      </div>
      <p className="max-w-3xl text-neutral-500">
        Float the sample feedback panel or open a menu to compare clearer borders and deeper
        shadows. Try both light and dark themes. This proposal is only applied inside the showcase.
      </p>
    </div>
  );
}
