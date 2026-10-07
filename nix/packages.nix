# Flake packages: `nix build` / `nix run` produce the r3 binary.
{...}: {
  perSystem = {pkgs, ...}: {
    packages = let
      r3 = pkgs.callPackage ./r3.nix {};
    in {
      inherit r3;
      default = r3;
      inherit (pkgs) bun biome;
      node = pkgs.r3Node;
      npm = pkgs.r3Npm;
    };
  };
}
