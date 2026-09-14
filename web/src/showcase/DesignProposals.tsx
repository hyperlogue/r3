import { useId, useState } from "react";
import { Logo } from "../components/Logo.tsx";
import { Button, cn } from "../ui.tsx";
import "./design-proposals.css";

export function PrimaryColorSample() {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Logo className="size-10" />
        <p className="max-w-3xl text-sm text-neutral-500">
          Keeping the logo blue. The current primary button uses a darker shade at rest (#4e41f4),
          then the exact logo blue on hover (#6164ff). Try hovering or using Tab.
        </p>
      </div>
      <div className="grid border border-neutral-300 dark:border-neutral-700 md:grid-cols-2">
        {(["Light", "Dark"] as const).map((theme) => (
          <div
            key={theme}
            className="space-y-3 p-4"
            style={{
              background: theme === "Light" ? "#ffffff" : "#0a0a0a",
              color: theme === "Light" ? "#525252" : "#a3a3a3",
            }}
          >
            <p className="text-xs">{theme}</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary">Save feedback</Button>
              <Button variant="primary" disabled>
                Disabled
              </Button>
            </div>
          </div>
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
        Interactive sketch: switch Float / Dock, then Active / Resolved. The composer belongs to
        Active and slides with that queue. Its draft is retained when you visit Resolved. Try
        reversing direction mid-transition.
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
                  {index === 0 && (
                    <textarea
                      aria-label="Sample draft"
                      placeholder="A draft stays in Active…"
                      className="mb-3 block min-h-20 w-full resize-none border border-neutral-300 bg-transparent p-2 text-xs dark:border-neutral-700"
                    />
                  )}
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
          The composer moves with Active, retaining its draft. Each queue retains its scroll
          position. The outgoing queue stops accepting interaction as soon as you switch. Keep card
          insert/delete animations for changes within a queue.
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
