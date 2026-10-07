# Shared project toolchain, applied in nix/nixpkgs.nix.
final: prev: let
  toolchain = final.callPackage ../toolchain.nix {bun = prev.bun;};
in {
  inherit (toolchain) bun biome;
  r3Node = toolchain.node;
  r3Npm = toolchain.npm;
}
