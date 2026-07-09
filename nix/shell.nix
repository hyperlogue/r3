# Dev shell entered by `nix develop` / direnv `use flake` (see .envrc).
# Bun runs everything (server, CLI, vite, tsc via node_modules), so the shell
# adds only what isn't a project dependency: bun itself, biome (not a devDep),
# and the beads task tracker (`br`) + its helper wrappers.
{...}: {
  perSystem = {pkgs, ...}: {
    devShells.default = pkgs.mkShell {
      name = "r3-dev";

      packages = with pkgs; [
        bun
        biome

        # bun.nix regeneration needs no shell package: the wasm bun2nix is an
        # exact-pinned devDependency and the package.json postinstall runs it
        # on every `bun install`. The flake's bun2nix input stays for the
        # consumer side only (fetchBunDeps + hook in nix/r3.nix); CI guards
        # drift (.github/workflows/sync-bun-nix.yml).

        git
        gh
        jq

        # Task tracking with beads — see .claude/skills/task-management.
        beads_rust

        # Quick triage capture: file an issue with the `inbox` label.
        (writeShellScriptBin "br-inbox" ''
          br create "$@" -l inbox
        '')

        # Before/after summary of uncommitted tracker changes: import the
        # JSONL, diff it, and re-list the touched issues.
        (writeShellScriptBin "br-diff" ''
          br sync --import-only
          diff_output=$(git diff .beads/issues.jsonl)
          if [ -z "$diff_output" ]; then
            echo "No uncommitted issue changes."
            exit 0
          fi
          fmt='"\(.id) [P\(.priority)] [\(.status)] [\(.issue_type // "-")] \(.title)"'
          before=$(echo "$diff_output" | grep '^-{' | sed 's/^-//' | jq -r "$fmt" | sort)
          ids=$(echo "$diff_output" | grep '^[+-]{' | sed 's/^[+-]//' | jq -r '.id' | sort -u)
          if [ -n "$before" ]; then
            echo "Before:"
            echo "$before"
            echo
          fi
          echo "After:"
          # shellcheck disable=SC2086
          br list -s open -s closed -s in_progress $(echo "$ids" | xargs -I{} echo --id {})
        '')
      ];

      shellHook = ''
        export R3_ROOT_DIR=$PWD
      '';
    };
  };
}
