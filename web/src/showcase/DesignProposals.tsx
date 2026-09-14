import { type CSSProperties, useId, useState } from "react";
import { Button, cn } from "../ui.tsx";
import "./design-proposals.css";

const palettes = [
  {
    name: "Tangerine",
    fill: "#fb923c",
    hover: "#fdba74",
    ink: "#431407",
    contrast: "6.9:1",
    description: "Warm and energetic. My pick for the primary action.",
  },
  {
    name: "Sunflower",
    fill: "#facc15",
    hover: "#fde047",
    ink: "#422006",
    contrast: "9.5:1",
    description: "Bright and playful. Closest to our existing amber attention color.",
  },
  {
    name: "Coral",
    fill: "#e65d45",
    hover: "#ef765f",
    ink: "#2b110c",
    contrast: "5.1:1",
    description: "Lively and warm. Closest to our existing red destructive actions.",
  },
] as const;

function paletteStyle(palette: (typeof palettes)[number]): CSSProperties {
  return {
    "--proposal-fill": palette.fill,
    "--proposal-hover": palette.hover,
    "--proposal-ink": palette.ink,
  } as CSSProperties;
}

export function PrimaryColorProposals() {
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-neutral-500">
        Three button proposals, shown on both surfaces. Hover or Tab to try them. Dark text keeps
        the bright fills readable. These samples change the action button only; choosing a full
        primary palette would also affect selections, focus rings, and agent accents.
      </p>
      <div className="grid gap-4 lg:grid-cols-3">
        {palettes.map((palette) => (
          <article
            key={palette.name}
            aria-label={`${palette.name} proposal`}
            className="border border-neutral-300 dark:border-neutral-700"
            style={paletteStyle(palette)}
          >
            <div className="space-y-2 p-4">
              <h3 className="font-semibold">{palette.name}</h3>
              <p className="min-h-10 text-xs text-neutral-500">{palette.description}</p>
              <p className="text-xs text-neutral-500">
                {palette.fill} · text contrast {palette.contrast}
              </p>
            </div>
            {(["Light", "Dark"] as const).map((theme) => (
              <div
                key={theme}
                className="space-y-3 border-t border-neutral-300 p-4 dark:border-neutral-700"
                style={{
                  background: theme === "Light" ? "#ffffff" : "#0a0a0a",
                  color: theme === "Light" ? "#525252" : "#a3a3a3",
                }}
              >
                <p className="text-xs">{theme}</p>
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="primary" className="proposal-primary">
                    Save feedback
                  </Button>
                  <Button variant="primary" className="proposal-primary" disabled>
                    Disabled
                  </Button>
                </div>
              </div>
            ))}
          </article>
        ))}
      </div>
    </div>
  );
}

const queues = [
  { label: "Active", notes: ["Keep the title easy to scan.", "Give the content room to breathe."] },
  { label: "Resolved", notes: ["Markdown follows the theme.", "The file order matches the list."] },
] as const;

export function FeedbackMotionProposal() {
  const [floating, setFloating] = useState(false);
  const [tab, setTab] = useState(0);
  const id = useId();
  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-neutral-500">
        Interactive sketch: switch Float / Dock, then Active / Resolved. The composer stays in place
        while the two queues slide. Try reversing direction mid-transition.
      </p>
      <div
        className="proposal-workspace relative isolate h-[540px] overflow-hidden border border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900"
        data-floating={floating}
      >
        <div
          className="h-full overflow-hidden p-5"
          style={{ width: floating ? "100%" : "calc(100% - var(--proposal-panel-width))" }}
        >
          <div className="max-w-lg space-y-4 text-sm">
            <p className="text-xs text-neutral-500">Sample content</p>
            <h3 className="text-xl font-semibold">Room for ideas</h3>
            <p className="text-neutral-500">
              A docked panel shares the workspace. A floating panel sits over the document.
            </p>
            <div className="space-y-3" aria-hidden="true">
              {[100, 85, 93, 60, 100, 75].map((width, index) => (
                <div
                  key={index}
                  className="h-2 bg-neutral-200 dark:bg-neutral-800"
                  style={{ width: `${width}%` }}
                />
              ))}
            </div>
          </div>
        </div>
        <aside
          aria-label="Feedback motion sketch"
          className={cn(
            "proposal-panel flex flex-col border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-950",
            floating && "r3-floating",
          )}
        >
          <header className="flex items-center justify-between border-b border-neutral-200 p-3 dark:border-neutral-800">
            <h3 className="text-sm font-semibold">Feedback</h3>
            <Button onClick={() => setFloating(!floating)}>{floating ? "Dock" : "Float"}</Button>
          </header>
          <div className="flex gap-2 p-3" role="tablist" aria-label="Sample feedback queues">
            {queues.map((queue, index) => (
              <Button
                key={queue.label}
                id={`${id}-tab-${index}`}
                role="tab"
                aria-selected={tab === index}
                aria-controls={`${id}-queue-${index}`}
                tabIndex={tab === index ? 0 : -1}
                variant={tab === index ? "default" : "ghost"}
                onClick={() => setTab(index)}
                onKeyDown={(event) => {
                  const next =
                    event.key === "ArrowLeft" || event.key === "Home"
                      ? 0
                      : event.key === "ArrowRight" || event.key === "End"
                        ? 1
                        : null;
                  if (next === null) return;
                  event.preventDefault();
                  setTab(next);
                  document.getElementById(`${id}-tab-${next}`)?.focus();
                }}
              >
                {queue.label} {queue.notes.length}
              </Button>
            ))}
          </div>
          <div className="border-y border-neutral-200 p-3 dark:border-neutral-800">
            <textarea
              aria-label="Sample draft"
              placeholder="A draft stays here while switching queues…"
              className="block min-h-16 w-full resize-none border border-neutral-300 bg-transparent p-2 text-xs dark:border-neutral-700"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <div
              className="proposal-queues flex h-full"
              style={{ transform: `translateX(-${tab * 100}%)` }}
            >
              {queues.map((queue, index) => (
                <div
                  key={queue.label}
                  id={`${id}-queue-${index}`}
                  role="tabpanel"
                  aria-labelledby={`${id}-tab-${index}`}
                  aria-hidden={tab !== index}
                  inert={tab !== index}
                  className="w-full shrink-0 overflow-y-auto p-3"
                >
                  {queue.notes.map((note) => (
                    <article
                      key={note}
                      className="mb-3 space-y-3 border border-neutral-300 p-3 text-xs dark:border-neutral-700"
                    >
                      <p className="text-neutral-500">{queue.label} · sample thread</p>
                      <p>{note}</p>
                      <Button variant="ghost">Reply</Button>
                    </article>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
      <div className="grid gap-4 text-sm md:grid-cols-2">
        <p>
          <strong>Queue switch · 220 ms.</strong> Active lives on the left, Resolved on the right.
          Each retains its scroll position. The outgoing queue stops accepting interaction as soon
          as you switch. Keep card insert/delete animations for changes within a queue.
        </p>
        <p>
          <strong>Float / dock · 240 ms.</strong> A short glide, with the corners and elevation
          following the mode. Content takes its new width immediately in this sketch. In the real
          panel, animate from its current dragged position and keep drafts, focus, and size intact.
        </p>
      </div>
      <p className="text-xs text-neutral-500">
        Both effects respect reduced motion. This sketch leaves the production panel unchanged;
        adapting its scrolling, row animations, and drag handling is the main implementation work.
      </p>
    </div>
  );
}
