// Shiki tokenizer isolate — no db/git/hono. Speaks { id, code, lang, light, dark }
// → { id, tokens, bg, fg } | { id, error }.

import { codeToTokens } from "shiki";

const w = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
};

w.onmessage = async (event: MessageEvent) => {
  const { id, code, lang, light, dark } = event.data as {
    id: number;
    code: string;
    lang: string;
    light: string;
    dark: string;
  };
  try {
    const r = await codeToTokens(code, {
      lang: lang as never,
      themes: { light, dark },
      defaultColor: false,
    });
    w.postMessage({ id, tokens: r.tokens, bg: r.bg, fg: r.fg });
  } catch (e) {
    w.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
