import { withThemeByClassName } from "@storybook/addon-themes";
import type { Decorator, Preview } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
// Storybook's CSS entry: re-exports the app stylesheet and adds .storybook to
// Tailwind's sources (so decorator-only utilities like min-h-screen exist here
// but not in the app bundle). The Tailwind v4 Vite plugin (see main.ts)
// compiles it. See preview.css for the rationale.
import "./preview.css";

// Components that read from React Query (Sidebar, SettingsPopup, FeedbackPanel,
// FileView) get a fresh client per story. Network is disabled — a story seeds
// the cache up-front via `parameters.queryData: [[queryKey, data], ...]`, so
// `useQuery` resolves synchronously without ever hitting fetch.
const QuerySeed = ({
  seed,
  children,
}: {
  seed: [readonly unknown[], unknown][] | undefined;
  children: React.ReactNode;
}) => {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            refetchOnMount: false,
            refetchOnWindowFocus: false,
            refetchInterval: false,
            staleTime: Number.POSITIVE_INFINITY,
          },
        },
      }),
  );
  for (const [key, data] of seed ?? []) client.setQueryData(key, data);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

const withQueryClient: Decorator = (Story, context) => (
  <QuerySeed seed={context.parameters.queryData}>
    <Story />
  </QuerySeed>
);

// Paint the app's surface colours behind every story so contrast matches the
// real shell in both themes.
const withSurface: Decorator = (Story) => (
  <div className="min-h-screen bg-neutral-50 p-6 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
    <Story />
  </div>
);

export const decorators = [
  withQueryClient,
  withSurface,
  withThemeByClassName({
    themes: { light: "", dark: "dark" },
    defaultTheme: "light",
    parentSelector: "html",
  }),
];

const preview: Preview = {
  parameters: {
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
    // Our own surface decorator handles backgrounds; keep SB's own off.
    backgrounds: { disable: true },
    layout: "fullscreen",
  },
};

export default preview;
