# Shared toolchain versions; Nix consumes the platform archives from the npm lock.
{
  lib,
  stdenv,
  stdenvNoCC,
  fetchurl,
  autoPatchelfHook,
  makeWrapper,
  runCommand,
  nodejs_24,
  bun,
}: let
  manifest = builtins.fromJSON (builtins.readFile ../toolchain/package.json);
  lock = builtins.fromJSON (builtins.readFile ../toolchain/package-lock.json);
  platform =
    {
      x86_64-linux = "linux-x64";
      aarch64-linux = "linux-arm64";
      x86_64-darwin = "darwin-x64";
      aarch64-darwin = "darwin-arm64";
    }.${
      stdenvNoCC.hostPlatform.system
    };
  source = name: let
    package = lock.packages."node_modules/${name}";
  in
    assert lib.assertMsg (lock.packages."".devDependencies == manifest.devDependencies)
    "Run npm install --package-lock-only in toolchain after changing its pins.";
      fetchurl {
        url = package.resolved;
        hash = package.integrity;
      };
  # Expose only Node, so its bundled npm cannot shadow the shared npm pin.
  node = assert nodejs_24.version == manifest.engines.node;
    runCommand "node-${nodejs_24.version}" {
      inherit (nodejs_24) version;
      meta.mainProgram = "node";
    } ''
      mkdir -p "$out/bin"
      ln -s ${nodejs_24}/bin/node "$out/bin/node"
    '';
in {
  bun = bun.overrideAttrs (_: {
    version = manifest.devDependencies.bun;
    src = source "@oven/bun-${lib.replaceStrings ["arm64"] ["aarch64"] platform}";
    sourceRoot = "package";
    installPhase = ''
      runHook preInstall
      install -Dm755 bin/bun "$out/bin/bun"
      ln -s bun "$out/bin/bunx"
      runHook postInstall
    '';
  });
  biome = stdenvNoCC.mkDerivation {
    pname = "biome";
    version = manifest.devDependencies."@biomejs/biome";
    src = source "@biomejs/cli-${platform}";
    nativeBuildInputs = lib.optionals stdenvNoCC.hostPlatform.isLinux [autoPatchelfHook];
    buildInputs = lib.optionals stdenvNoCC.hostPlatform.isLinux [stdenv.cc.cc.lib];
    dontConfigure = true;
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      install -Dm755 biome "$out/bin/biome"
      runHook postInstall
    '';
    meta.mainProgram = "biome";
  };
  inherit node;
  npm = stdenvNoCC.mkDerivation {
    pname = "npm";
    version = manifest.devDependencies.npm;
    src = source "npm";
    nativeBuildInputs = [makeWrapper];
    dontConfigure = true;
    dontBuild = true;
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/lib/npm"
      cp -r . "$out/lib/npm/"
      makeWrapper ${node}/bin/node "$out/bin/npm" --add-flags "$out/lib/npm/bin/npm-cli.js"
      makeWrapper ${node}/bin/node "$out/bin/npx" --add-flags "$out/lib/npm/bin/npx-cli.js"
      runHook postInstall
    '';
    meta.mainProgram = "npm";
  };
}
