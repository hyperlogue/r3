# beads_rust (`br`): local-first issue tracker for AI coding agents, backed by
# SQLite. r3 uses it for task management (see .claude/skills/task-management).
# Built from source pinned to the version the skill documents. Needs the fenix
# nightly toolchain — a transitive dep (fsqlite-types) uses
# `#![feature(portable_simd)]`, which only the nightly channel accepts.
{
  lib,
  stdenv,
  fetchFromGitHub,
  installShellFiles,
  fenix,
  makeRustPlatform,
}: let
  toolchain = fenix.latest.toolchain;
  rustPlatform = makeRustPlatform {
    cargo = toolchain;
    rustc = toolchain;
  };
in
  rustPlatform.buildRustPackage {
    pname = "beads_rust";
    version = "0.2.15";

    src = fetchFromGitHub {
      owner = "Dicklesworthstone";
      repo = "beads_rust";
      rev = "d4b7c6da34228dcb176c66fe689d6cb22167e082";
      hash = "sha256-21dBoudb+Uq+skWzIBRe0XWWz/jR+1QI+1o6SVoc91Y=";
    };

    # Skip `self_update`; the binary is managed by Nix.
    buildNoDefaultFeatures = true;

    cargoHash = "sha256-21pHDLRvfEmLc3KruIYUQfxFxPrSDwTiOvqTYbEciOI=";

    nativeBuildInputs = [installShellFiles];

    # Tests require filesystem and may need network access.
    doCheck = false;

    postInstall = lib.optionalString (stdenv.buildPlatform.canExecute stdenv.hostPlatform) ''
      installShellCompletion --cmd br \
        --bash <($out/bin/br completions bash) \
        --fish <($out/bin/br completions fish) \
        --zsh <($out/bin/br completions zsh)
    '';

    meta = {
      description = "Local-first issue tracker for AI coding agents backed by SQLite";
      homepage = "https://github.com/Dicklesworthstone/beads_rust";
      license = lib.licenses.mit;
      mainProgram = "br";
    };
  }
