# The single-file `r3` binary. r3's build (see scripts/compile.ts) is one
# `Bun.build({compile})` over the CLI entry — which imports the daemon, which
# imports web/index.html — preceded by a browser-target Tailwind pass for the
# SPA stylesheet, so the SPA and the Hono server land in one executable. That's
# more than the bun2nix default module->binary path, so we drive it with a
# custom buildPhase on top of stdenv + the bun2nix hook (which installs the
# pinned deps from bun.nix).
{
  lib,
  stdenv,
  bun,
  bun2nix,
}: let
  # Track the repo's declared version instead of hand-syncing a literal here —
  # package.json is the version source the release flow already keys off (the
  # release scripts assert shared/version.ts against it), so read it rather than
  # let this drift.
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;

  # Only the inputs the build actually reads, so an unrelated edit (README,
  # docs, the nix/ files themselves) doesn't bust the build cache.
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../package.json
      ../tsconfig.json
      ../bun.lock
      ../bun.nix
      ../scripts
      ../server
      ../cli
      ../shared
      ../web
    ];
  };

  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ../bun.nix;
  };
in
  stdenv.mkDerivation {
    pname = "r3";
    inherit version src;

    nativeBuildInputs = [bun bun2nix.hook];
    bunRoot = ".";
    inherit bunDeps;

    # `bun build --compile` appends bytecode to a copy of the (already
    # NixOS-patched) bun binary; the default fixupPhase's strip/patchelf would
    # corrupt that payload. bun2nix.mkDerivation disables fixup for exactly this
    # reason — we must do the same since we build the binary by hand.
    dontFixup = true;
    # No bun:test suite; don't let the hook's default checkPhase run `bun test`.
    doCheck = false;

    # `bun run build` == scripts/compile.ts: one Bun.build --compile -> ./r3
    buildPhase = ''
      runHook preBuild
      bun run build
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      install -Dm755 r3 "$out/bin/r3"
      runHook postInstall
    '';

    meta = with lib; {
      description = "r3 — local-first review server + CLI for AI code/docs, as one binary";
      license = licenses.mit;
      platforms = platforms.unix;
      mainProgram = "r3";
    };
  }
