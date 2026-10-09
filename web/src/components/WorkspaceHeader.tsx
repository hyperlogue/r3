import { type ReactNode, useRef } from "react";
import { Logo, type LogoHandle } from "./Logo.tsx";

// Shared visual header; navigation and application-level tools belong to its host.
export function WorkspaceHeader({
  children,
  tools,
  homeHref = "#",
  onHome,
}: {
  children?: ReactNode;
  tools?: ReactNode;
  homeHref?: string;
  onHome?: () => void;
}) {
  const logo = useRef<LogoHandle>(null);
  return (
    <header
      data-app-header
      className="relative z-40 flex min-h-[calc(2rem+4px)] shrink-0 items-center gap-2 border-b border-neutral-300 bg-white py-[2px] pl-3 max-md:gap-1 max-md:pl-2 dark:border-neutral-700 dark:bg-neutral-950"
    >
      <nav aria-label="Main navigation" className="flex shrink-0 items-center gap-1.5 self-stretch">
        <button
          type="button"
          aria-label="Animate logo"
          onClick={() => logo.current?.flick()}
          className="group flex items-center max-md:min-h-9"
        >
          <Logo
            ref={logo}
            className="size-5 transition-transform duration-75 group-active:scale-90"
          />
        </button>
        <a
          href={homeHref}
          title="Artifact library"
          onClick={(event) => {
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey ||
              event.button !== 0
            )
              return;
            if (onHome) {
              event.preventDefault();
              onHome();
            }
          }}
          className="flex items-center self-stretch text-sm font-semibold text-neutral-800 hover:text-primary-600 max-md:min-h-9 dark:text-neutral-100 dark:hover:text-primary-400"
        >
          r3
        </a>
      </nav>
      {children ? (
        <>
          <span
            aria-hidden="true"
            className="mx-1.5 h-4 w-px shrink-0 bg-neutral-200 max-md:mx-0.5 dark:bg-neutral-800"
          />
          {children}
        </>
      ) : (
        <div className="flex-1" />
      )}
      <div className="flex shrink-0 items-center self-stretch">{tools}</div>
    </header>
  );
}
