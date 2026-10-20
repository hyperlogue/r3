import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { ApplicationUIProvider } from "../application-ui.tsx";
import { initializeLocale } from "../i18n.ts";
import "../showcase/forms.ts";
import "../main.css";
import { resetPractice, Tutorial } from "./Tutorial.tsx";

resetPractice();
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
initializeLocale();
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <ApplicationUIProvider>
      <Tutorial />
    </ApplicationUIProvider>
  </QueryClientProvider>,
);
