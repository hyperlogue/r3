# Build the per-system `pkgs` once, with the bun2nix overlay applied so
# `pkgs.bun2nix` (mkDerivation / fetchBunDeps / hook) is available to the
# package and shell modules, scoped to r3's single overlay.
{inputs, ...}: {
  perSystem = {system, ...}: {
    _module.args.pkgs = import inputs.nixpkgs {
      inherit system;
      overlays = [
        inputs.bun2nix.overlays.default
        inputs.fenix.overlays.default
        (import ./overlay)
      ];
    };
  };
}
