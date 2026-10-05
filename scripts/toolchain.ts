import { devDependencies } from "../toolchain/package.json";

export function assertBuildToolchain() {
  if (Bun.version !== devDependencies.bun) {
    throw new Error(
      `Builds require Bun ${devDependencies.bun}; found ${Bun.version}. Enter the Nix shell or install the pinned toolchain.`,
    );
  }
}
