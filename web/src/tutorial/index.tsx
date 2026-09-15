import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import "../showcase/forms.ts";
import "../main.css";
import { resetPractice, Tutorial } from "./Tutorial.tsx";

resetPractice();
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <Tutorial />
  </QueryClientProvider>,
);
