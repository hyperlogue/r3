import { promptExamples } from "./prompt-examples.ts";

export function startPromptDemo(root: HTMLElement) {
  const typed = root.querySelector<HTMLElement>("[data-typed-prompt]")!;
  const readable = root.querySelector<HTMLElement>("[data-readable-prompt]")!;
  const response = root.querySelector<HTMLElement>("[data-prompt-response]")!;
  const title = root.querySelector<HTMLElement>("[data-prompt-title]")!;
  const play = root.querySelector<HTMLButtonElement>("[data-prompt-play]")!;
  const choices = root.querySelectorAll<HTMLButtonElement>("[data-prompt-choice]");
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let index = 0;
  let visible = false;
  let paused = motion.matches;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function render(animate: boolean) {
    clearTimeout(timer);
    const example = promptExamples[index]!;
    root.dataset.example = String(index);
    root.dataset.paused = String(paused);
    root.dataset.phase = "ready";
    typed.textContent = example.prompt;
    readable.textContent = example.prompt;
    response.textContent = example.response;
    title.textContent = example.title;
    play.setAttribute("aria-label", `${paused ? "Play" : "Pause"} prompt animation`);
    play.title = `${paused ? "Play" : "Pause"} animation`;
    for (const choice of choices)
      choice.setAttribute("aria-pressed", String(Number(choice.dataset.promptChoice) === index));
    if (!animate || paused || motion.matches || !visible || document.hidden) return;

    let characters = 0;
    typed.textContent = "";
    root.dataset.phase = "typing";
    const type = () => {
      characters = Math.min(characters + 2, example.prompt.length);
      typed.textContent = example.prompt.slice(0, characters);
      if (characters < example.prompt.length) timer = setTimeout(type, 30);
      else {
        root.dataset.phase = "ready";
        timer = setTimeout(() => {
          root.dataset.phase = "leaving";
          timer = setTimeout(() => {
            index = (index + 1) % promptExamples.length;
            render(true);
          }, 200);
        }, 4600);
      }
    };
    timer = setTimeout(type, 300);
  }

  play.addEventListener("click", () => {
    paused = !paused;
    render(true);
  });
  for (const choice of choices)
    choice.addEventListener("click", () => {
      index = Number(choice.dataset.promptChoice);
      // Keep a chosen prompt still long enough to read or select its text.
      paused = true;
      render(false);
    });
  motion.addEventListener("change", () => {
    if (motion.matches) paused = true;
    render(true);
  });
  document.addEventListener("visibilitychange", () => render(true));
  const observer = new IntersectionObserver(
    (entries) => {
      visible = entries.some((entry) => entry.isIntersecting);
      render(true);
    },
    { threshold: 0.25 },
  );
  observer.observe(root);
  render(false);
  window.addEventListener("pagehide", () => clearTimeout(timer));
  window.addEventListener("pageshow", () => render(true));
}
