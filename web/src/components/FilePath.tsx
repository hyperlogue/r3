import { type ReactNode, useEffect, useRef, useState } from "react";
import { copyText } from "../clipboard.ts";
import { cn, StrokeIcon } from "../ui.tsx";

// Each segment copies the suffix starting there. Keep its hover, clipboard
// result, and confirmation timer local to the header instead of the file body.
export function FilePath({ path, action }: { path: string; action?: ReactNode }) {
  const segments = path.split("/");
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState<number | null>(null);
  const [result, setResult] = useState<{ index: number; ok: boolean } | null>(null);
  const request = useRef(0);
  const active = hovered ?? focused;
  useEffect(
    () => () => {
      request.current++;
    },
    [],
  );
  useEffect(() => {
    if (!result?.ok) return;
    const timer = setTimeout(() => setResult(null), 1000);
    return () => clearTimeout(timer);
  }, [result]);

  const copy = async (index: number) => {
    const nonce = ++request.current;
    const ok = await copyText(segments.slice(index).join("/"));
    if (nonce === request.current) setResult({ index, ok });
  };
  const message = result
    ? `${result.ok ? "Copied" : "Could not copy"}: ${segments.slice(result.index).join("/")}`
    : "";

  return (
    <div className="min-w-0 flex-1">
      <div className="group/file-path flex w-fit max-w-full items-center gap-1 text-xs leading-4">
        {/* Clip from the directory end so the filename survives a narrow pane.
            The inner isolate keeps the actual path and its segments in order. */}
        <div dir="rtl" className="min-w-0 truncate text-left" onMouseLeave={() => setHovered(null)}>
          <span dir="ltr" className="font-mono [unicode-bidi:isolate]">
            {segments.map((segment, index) => {
              const suffix = segments.slice(index).join("/");
              return (
                <button
                  key={index}
                  type="button"
                  aria-label={`Copy ${suffix}`}
                  title={result?.index === index ? message : `Copy ${suffix}`}
                  className={cn(
                    "underline-offset-[3px] focus-visible:outline-2 focus-visible:outline-offset-[-1px] focus-visible:outline-primary-500",
                    index === segments.length - 1
                      ? "font-medium text-neutral-800 dark:text-neutral-100"
                      : "text-neutral-400",
                    active !== null && index >= active && "underline",
                    result?.ok &&
                      index >= result.index &&
                      "text-success-700! dark:text-success-300!",
                  )}
                  onMouseEnter={() => setHovered(index)}
                  onFocus={() => setFocused(index)}
                  onBlur={() => setFocused(null)}
                  onClick={() => void copy(index)}
                >
                  {segment}
                  {index < segments.length - 1 && "/"}
                </button>
              );
            })}
          </span>
        </div>
        {action}
        {result && (
          <span
            data-path-copy={result.ok ? "success" : "error"}
            aria-hidden="true"
            title={message}
            className={cn(
              "pointer-events-none flex h-4.5 shrink-0 items-center gap-0.5",
              result.ok
                ? "text-success-700 dark:text-success-300"
                : "text-danger-600 dark:text-danger-400",
            )}
          >
            {result.ok ? (
              <>
                <StrokeIcon className="size-3.5">
                  <rect x="8" y="8" width="12" height="12" rx="2" />
                  <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
                </StrokeIcon>
                <StrokeIcon className="size-3">
                  <path d="m5 12 4 4L19 6" />
                </StrokeIcon>
              </>
            ) : (
              <StrokeIcon className="size-3.5">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v6m0 3v1" />
              </StrokeIcon>
            )}
          </span>
        )}
        <span role="status" className="sr-only">
          {message}
        </span>
      </div>
    </div>
  );
}
