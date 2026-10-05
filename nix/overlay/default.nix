# Project-local package overlay. Adds the beads task tracker (`br`),
# which nixpkgs doesn't carry. Applied in nix/nixpkgs.nix.
final: prev: let
  toolchain = final.callPackage ../toolchain.nix {bun = prev.bun;};
in {
  inherit (toolchain) bun biome;
  r3Node = toolchain.node;
  r3Npm = toolchain.npm;
  beads_rust = final.callPackage ./beads_rust.nix {};
}
