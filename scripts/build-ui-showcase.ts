import { buildComponentArtifact } from "./build-component-artifact.ts";

await buildComponentArtifact({
  entrypoint: "web/src/showcase/index.tsx",
  directory: "dist/ui-showcase",
  title: "r3 UI component showcase",
});
