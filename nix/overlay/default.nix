# Project-local package overlay. Adds the beads task tracker (`br`),
# which nixpkgs doesn't carry. Applied in nix/nixpkgs.nix.
final: _prev: {
  beads_rust = final.callPackage ./beads_rust.nix {};
}
