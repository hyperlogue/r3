import { describe, expect, test } from "bun:test";
import { bundledLanguagesInfo } from "shiki";
import { collectLanguageFileTypes } from "../scripts/gen-highlight-languages.ts";
import fileTypes from "./highlight-file-types.gen.json";
import { langForFence, langForPath } from "./highlight-languages.ts";

describe("source and diff language detection", () => {
  test("every bundled language and alias can select its grammar by suffix", () => {
    for (const { id, aliases } of bundledLanguagesInfo) {
      for (const suffix of [id, ...(aliases ?? [])]) {
        expect(langForPath(`src/example.${suffix}`)).toBe(id);
      }
    }
    expect(langForPath("output.ansi")).toBe("ansi");
  });

  test("generated filename metadata matches the installed Shiki grammars", async () => {
    // An upgrade must refresh the index, including fileTypes added to existing
    // grammars. IDs/aliases alone do not cover real source filenames.
    expect(await collectLanguageFileTypes()).toEqual(fileTypes);
  });

  test.each([
    ["src/main.dart", "dart"],
    ["src/Main.hs-boot", "haskell"],
    ["src/core.cljc", "clojure"],
    ["build.zig.zon", "zig"],
    ["src/main.adb", "ada"],
    ["src/main.ml", "ocaml"],
    ["src/main.mli", "ocaml"],
    ["infra/main.bicep", "bicep"],
    ["infra/main.tfvars", "terraform"],
    ["scripts/setup.psm1", "powershell"],
    ["src/index.mts", "typescript"],
    ["src/index.cts", "typescript"],
    ["src/Component.vine.ts", "vue-vine"],
    ["src/app.ex", "elixir"],
    ["test/app.exs", "elixir"],
    ["templates/app.heex", "html"],
    ["templates/app.blade.php", "blade"],
    ["templates/app.html.erb", "erb"],
    ["templates/app.html.twig", "twig"],
    ["docs/guide.adoc.txt", "asciidoc"],
    ["config/nginx.conf", "nginx"],
    ["config/bird.conf", "bird2"],
    ["src/MAIN.DART", "dart"],
    ["src/💡.文言", "wenyan"],
  ])("recognizes %s as %s", (path, language) => {
    expect(langForPath(path)).toBe(language);
  });

  test.each([
    ["build/Makefile", "make"],
    ["build/Makefile.am", "make"],
    ["build/CMakeLists.txt", "cmake"],
    ["images/Containerfile", "docker"],
    ["images/Dockerfile.dev", "docker"],
    ["scripts/Justfile", "just"],
    ["app/Gemfile", "ruby"],
    ["app/Jenkinsfile", "groovy"],
    ["config/.bashrc", "shellscript"],
    ["config/.env", "dotenv"],
    ["config/.env.production", "dotenv"],
    ["config/.htaccess", "apache"],
    ["config/.ssh/config", "ssh-config"],
    ["config/.vimrc", "viml"],
    [".github/CODEOWNERS", "codeowners"],
    [".git/COMMIT_EDITMSG", "git-commit"],
    [".git/rebase-merge/git-rebase-todo", "git-rebase"],
  ])("recognizes the special filename %s", (path, language) => {
    expect(langForPath(path)).toBe(language);
  });

  test("ambiguous extensions have stable defaults", () => {
    expect(langForPath("api.h")).toBe("c");
    expect(langForPath("app.m")).toBe("objective-c");
    expect(langForPath("app.matlab")).toBe("matlab");
    expect(langForPath("app.fs")).toBe("fsharp");
    expect(langForPath("app.pl")).toBe("perl");
    expect(langForPath("app.v")).toBe("v");
    expect(langForPath("app.vh")).toBe("verilog");
    expect(langForPath("app.sv")).toBe("system-verilog");
    expect(langForPath("app.php")).toBe("php");
    expect(langForPath("app.conf")).toBe("ini");
    expect(langForPath("app.bib")).toBe("bibtex");
  });

  test.each([
    "",
    "src/",
    "README",
    "a.txt",
    "a.unknown",
    "a.__proto__",
    "a.constructor",
  ])("unrecognized path %s stays plain text", (path) => expect(langForPath(path)).toBeNull());

  test("source associations do not change retained Markdown fence selection", () => {
    expect(langForFence("ts title=example.ts")).toBe("ts");
    expect(langForFence("exs")).toBe("elixir");
    expect(langForFence("heex")).toBe("html");
    expect(langForFence("adb")).toBeNull();
    expect(langForFence("text")).toBeNull();
  });
});
