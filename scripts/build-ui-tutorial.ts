import { buildComponentArtifact } from "./build-component-artifact.ts";

await buildComponentArtifact({
  entrypoint: "web/src/tutorial/index.tsx",
  directory: "dist/ui-tutorial",
  title: "Tutorial",
  navigation: "web/src/tutorial/navigation.ts",
});
