import { useRef } from "react";
import { createRoot } from "react-dom/client";
import { Logo, type LogoHandle } from "../web/src/components/Logo.tsx";
import { t } from "./i18n.ts";

function SiteLogo() {
  const logo = useRef<LogoHandle>(null);
  return (
    <button
      type="button"
      className="site-logo-button"
      aria-label={t("Animate logo")}
      onClick={() => logo.current?.flick()}
    >
      <Logo ref={logo} className="site-logo-mark" />
    </button>
  );
}

export function mountSiteLogo() {
  const host = document.querySelector("[data-site-logo]");
  if (host) createRoot(host).render(<SiteLogo />);
}
