import { useEffect, useRef } from "react";
import { useArtifactEvents } from "./artifact-hooks.ts";
import { Logo, type LogoHandle } from "./components/Logo.tsx";
import { ReviewSwitcher } from "./components/ReviewSwitcher.tsx";
import { SettingsPopup } from "./components/SettingsPopup.tsx";
import { DemoChrome } from "./demo-chrome.tsx";
import { ArtifactHome } from "./pages/ArtifactHome.tsx";
import { ArtifactView } from "./pages/ArtifactView.tsx";
import { useRoute } from "./router.ts";

function Header() {
  // Logo click is a fidget toy (Logo.flick), not navigation.
  const logo = useRef<LogoHandle>(null);
  return (
    <header className="flex h-[2rem] shrink-0 items-center justify-between border-b border-neutral-300 bg-white pl-3 dark:border-neutral-700 dark:bg-neutral-950">
      <div className="flex min-w-0 items-center gap-2 self-stretch">
        <button
          type="button"
          onClick={() => logo.current?.flick()}
          className="group flex shrink-0 cursor-pointer items-center gap-1.5 text-sm font-semibold text-neutral-800 dark:text-neutral-100"
        >
          <Logo
            ref={logo}
            className="size-5 transition-transform duration-75 group-active:scale-90"
          />
          r3
        </button>
        <span aria-hidden="true" className="h-4 w-px shrink-0 bg-neutral-200 dark:bg-neutral-800" />
        <ReviewSwitcher />
      </div>
      <div className="flex items-center self-stretch">
        <DemoChrome />
        <SettingsPopup />
      </div>
    </header>
  );
}

export function App() {
  const { artifactId } = useRoute();
  useArtifactEvents();

  useEffect(() => {
    if (!artifactId) document.title = "r3";
  }, [artifactId]);

  return (
    <div className="flex h-full flex-col bg-neutral-50 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <Header />
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {artifactId ? <ArtifactView key={artifactId} artifactId={artifactId} /> : <ArtifactHome />}
      </main>
    </div>
  );
}
