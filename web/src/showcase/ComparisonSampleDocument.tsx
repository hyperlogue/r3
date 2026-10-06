import { useEffect, useRef, useState } from "react";
import type { ArtifactRenderedPaneProps } from "../pages/ArtifactView.tsx";
import { Button, cn } from "../ui.tsx";

// An inline sample permits reviewing the actual workspace inside a publication,
// where nested preview frames are intentionally forbidden. It executes no bytes.
export function ComparisonSampleDocument(props: ArtifactRenderedPaneProps) {
  const target = useRef<HTMLParagraphElement>(null);
  const [name, setName] = useState("");
  useEffect(() => {
    if (props.active === false || !props.jump) return;
    target.current?.scrollIntoView({ block: "nearest" });
    props.onLocated?.("anchored");
  }, [props.active, props.jump, props.onLocated]);
  const revised = props.version.seq > 1;
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-white p-6 dark:bg-neutral-950">
      <p className="mb-5 text-xs uppercase tracking-widest text-neutral-500">
        Sample document · v{props.version.seq}
      </p>
      <h1 className="mb-4 text-3xl font-semibold">A little closer.</h1>
      <p
        ref={target}
        className={cn(
          "mb-6 text-lg",
          props.jump &&
            props.highlightLocated !== false &&
            "outline-2 outline-offset-4 outline-primary-500",
        )}
      >
        {revised
          ? "Adjust the parameters and watch the error shrink. A small ripple still needs a closer fit."
          : "Can this model capture every ripple?"}
      </p>
      <label className="block text-sm">
        Name this experiment
        <input
          className="mt-2 block w-full border border-neutral-300 p-2 max-md:text-base dark:border-neutral-700"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Your draft stays here"
        />
      </label>
      {props.commenting && (
        <Button
          className="mt-4"
          onClick={() =>
            props.onTarget({
              kind: "rendered",
              versionSeq: props.version.seq,
              path: props.path,
              locator: { selector: "#model-note", label: "Model note" },
            })
          }
        >
          Comment on model note
        </Button>
      )}
    </div>
  );
}
