import { createRoot } from "react-dom/client";
import { FieldworkDocument } from "./FieldworkDocument.tsx";
import { PromptDocument } from "./PromptDocument.tsx";

const root = document.getElementById("root")!;
const scene = root.dataset.scene;
const revised = root.dataset.version !== "1";
createRoot(root).render(
  scene === "explainer" || scene === "brief" ? (
    <PromptDocument scene={scene} revised={revised} />
  ) : (
    <FieldworkDocument revised={revised} />
  ),
);
