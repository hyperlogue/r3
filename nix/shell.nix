# Dev shell entered by `nix develop` / direnv `use flake` (see .envrc).
# Bun runs everything (server, CLI, tsc via node_modules), so the shell
# adds the locked toolchain from toolchain/package-lock.json.
{...}: {
  perSystem = {pkgs, ...}: {
    devShells.default = pkgs.mkShell {
      name = "r3-dev";

      packages = with pkgs; [
        bun
        biome
        r3Node
        (lib.hiPrio r3Npm)

        # bun.nix regeneration needs no shell package: the wasm bun2nix is an
        # exact-pinned devDependency and the package.json postinstall runs it
        # on every `bun install`. The flake's bun2nix input stays for the
        # consumer side only (fetchBunDeps + hook in nix/r3.nix); CI guards
        # drift (.github/workflows/sync-bun-nix.yml).

        git
        gh
        jq
      ];

      shellHook = ''
        export R3_ROOT_DIR=$PWD
      '';
    };
  };
}
