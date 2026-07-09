import type { StorybookConfig } from "@storybook/react-vite";

// Storybook lives at the repo root (this is a root-level Bun monorepo — there is
// no web/package.json). Stories are colocated next to the components they
// document under web/src.
const config: StorybookConfig = {
  stories: ["../web/src/**/*.mdx", "../web/src/**/*.stories.@(ts|tsx)"],
  addons: [
    "@storybook/addon-essentials",
    "@storybook/addon-themes", // light/dark toggle by toggling `.dark` on <html>
  ],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  core: {
    disableTelemetry: true,
  },
  // The app itself is bundled by Bun (no Vite); Storybook is the only Vite
  // consumer left. We only need Tailwind v4 wired in here — @storybook/react-vite
  // already provides the React plugin.
  async viteFinal(viteConfig) {
    const { default: tailwindcss } = await import("@tailwindcss/vite");
    viteConfig.plugins ??= [];
    viteConfig.plugins.push(tailwindcss());
    return viteConfig;
  },
};

export default config;
