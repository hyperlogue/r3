import { t } from "./i18n.ts";
import { promptExamples } from "./prompt-examples.ts";

export function startPromptDemo(root: HTMLElement, onChange: (index: number) => void) {
  const prompt = root.querySelector<HTMLElement>("[data-prompt-text]")!;
  const response = root.querySelector<HTMLElement>("[data-prompt-response]")!;
  const play = root.querySelector<HTMLButtonElement>("[data-prompt-play]")!;
  const choices = root.querySelectorAll<HTMLButtonElement>("[data-prompt-choice]");
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let index = 0;
  let visible = false;
  let paused = motion.matches;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function render() {
    clearTimeout(timer);
    const example = promptExamples[index]!;
    root.dataset.example = String(index);
    root.dataset.paused = String(paused);
    root.dataset.phase = "ready";
    onChange(index);
    prompt.textContent = t(example.prompt);
    response.textContent = t(example.response);
    play.setAttribute("aria-label", t(paused ? "Play prompt animation" : "Pause prompt animation"));
    play.title = t(paused ? "Play animation" : "Pause animation");
    for (const choice of choices)
      choice.setAttribute("aria-pressed", String(Number(choice.dataset.promptChoice) === index));
    if (paused || motion.matches || !visible || document.hidden) return;
    timer = setTimeout(() => {
      root.dataset.phase = "leaving";
      timer = setTimeout(() => {
        index = (index + 1) % promptExamples.length;
        render();
      }, 420);
    }, 5200);
  }

  play.addEventListener("click", () => {
    paused = !paused;
    render();
  });
  for (const choice of choices)
    choice.addEventListener("click", () => {
      index = Number(choice.dataset.promptChoice);
      // A manually selected example stays still for reading and copying.
      paused = true;
      render();
    });
  motion.addEventListener("change", () => {
    if (motion.matches) paused = true;
    render();
  });
  document.addEventListener("visibilitychange", render);
  const observer = new IntersectionObserver(
    (entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      render();
    },
    { threshold: 0.25 },
  );
  observer.observe(root);
  render();
  window.addEventListener("pagehide", () => clearTimeout(timer));
  window.addEventListener("pageshow", render);
}
