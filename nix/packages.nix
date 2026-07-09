# Flake packages: `nix build` / `nix run` produce the r3 binary.
{...}: {
  perSystem = {
    pkgs,
    gitRev,
    ...
  }: {
    packages = let
      r3 = pkgs.callPackage ./r3.nix {inherit gitRev;};
    in {
      inherit r3;
      default = r3;
      # Re-export the overlay tools so they're buildable/runnable directly
      # (`nix run .#beads_rust`) and visible to CI, not only via the dev shell.
      inherit (pkgs) beads_rust;
    };
  };
}
