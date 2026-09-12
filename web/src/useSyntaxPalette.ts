import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, useEffect } from "react";
import { api } from "./api.ts";

// Highlighted bytes and palette rules share the selected theme. Keep one sheet
// for all source/diff blocks; no highlighter or theme package runs in the SPA.
export function useSyntaxPalette(theme: string): CSSProperties | undefined {
  const { data } = useQuery({
    queryKey: ["theme-style", theme],
    queryFn: () => api.themeStyle(theme),
    staleTime: Infinity,
  });
  useEffect(() => {
    if (!data) return;
    let sheet = document.head.querySelector<HTMLStyleElement>("style[data-r3-theme-css]");
    if (!sheet) {
      sheet = document.createElement("style");
      sheet.setAttribute("data-r3-theme-css", "");
      document.head.appendChild(sheet);
    }
    // Parse only CSS, never HTML. Reuse the sheet across navigation and themes.
    if (sheet.textContent !== data.css) sheet.textContent = data.css;
  }, [data]);
  return data
    ? ({
        "--shiki-light-bg": data.lightBg,
        "--shiki-dark-bg": data.darkBg,
        "--shiki-light": data.lightFg,
        "--shiki-dark": data.darkFg,
      } as CSSProperties)
    : undefined;
}
