import { useEffect, useState } from "react";
import { Button } from "../ui.tsx";
import "./overlay-contrast.css";

export function OverlayContrastPreview() {
  const [stronger, setStronger] = useState(false);
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
    <div className="grid items-center gap-5 text-sm md:grid-cols-2">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-medium">Overlay contrast proposal</span>
          <fieldset aria-label="Overlay contrast" className="flex gap-1">
            <Button
              variant={stronger ? "default" : "primary"}
              aria-pressed={!stronger}
              onClick={() => setStronger(false)}
            >
              Current
            </Button>
            <Button
              variant={stronger ? "primary" : "default"}
              aria-pressed={stronger}
              onClick={() => setStronger(true)}
            >
              Stronger
            </Button>
          </fieldset>
        </div>
        <p className="text-neutral-500">
          Compare the sample border and shadow here, then try floating the feedback panel or opening
          a menu below. This proposal applies only inside the showcase.
        </p>
      </div>
      <div className="grid min-h-44 place-items-center border border-neutral-200 bg-neutral-50 p-6 dark:border-neutral-800 dark:bg-neutral-900">
        <section
          aria-label="Overlay sample"
          className="r3-popover w-full max-w-xs rounded-lg border bg-white p-4 dark:bg-neutral-950"
        >
          <h3 className="font-medium">Sample overlay</h3>
          <p className="mt-2 text-neutral-500">
            Watch this border and shadow as you switch styles.
          </p>
        </section>
      </div>
    </div>
  );
}
