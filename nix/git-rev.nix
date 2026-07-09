# Expose the current git revision as a perSystem arg, so the `r3` package can
# bake it into the binary (GIT_COMMIT). shortRev on a clean tree, dirtyShortRev
# on a dirty one — never both; "unknown" outside a checkout.
{inputs, ...}: let
  gitRev =
    inputs.self.shortRev
    or inputs.self.dirtyShortRev
    or "unknown";
in {
  perSystem = _: {
    _module.args.gitRev = gitRev;
  };
}
