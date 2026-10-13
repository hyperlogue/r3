import { expect, test } from "bun:test";
import { ArtifactArgs, ArtifactCommandError } from "./artifact-args.ts";

const fails = (argv: string[], message: string) =>
  expect(() => new ArtifactArgs(argv)).toThrow(new ArtifactCommandError(message));

test("value flags accept --name=value and --name value; '=' inside the value is kept", () => {
  const args = new ArtifactArgs(["--title=a=b", "--kind", "html", "id"]);
  expect(args.value("title")).toBe("a=b");
  expect(args.value("kind")).toBe("html");
  expect(args.positional).toEqual(["id"]);
});

test("everything after -- is positional, and a lone - is a positional", () => {
  const args = new ArtifactArgs(["-", "--", "--json", "-x"]);
  expect(args.positional).toEqual(["-", "--json", "-x"]);
  expect(args.has("json")).toBe(false);
});

test("-m is shorthand for --message", () => {
  expect(new ArtifactArgs(["-m", "hi"]).value("message")).toBe("hi");
});

test("malformed options are rejected with a specific message", () => {
  fails(["-x"], "Unknown option: -x");
  fails(["--nope"], "Unknown option: --nope");
  fails(["--json=1"], "--json does not take a value");
  fails(["--title"], "--title requires a value");
  fails(["--title", "--json"], "--title requires a value");
  fails(["--kind", "a", "--kind", "b"], "--kind may only be specified once");
});

test("repeatable flags collect every value in order", () => {
  expect(new ArtifactArgs(["--file", "a", "--file=b"]).values("file")).toEqual(["a", "b"]);
});

test("allow() rejects flags a command does not support but always permits the globals", () => {
  expect(() => new ArtifactArgs(["--json", "--human"]).allow([])).not.toThrow();
  expect(() => new ArtifactArgs(["--title", "t"]).allow([])).toThrow(
    "--title is not supported by this command",
  );
});

test("sequence() requires a plain integer within range", () => {
  expect(new ArtifactArgs(["--version", "3"]).sequence()).toBe(3);
  expect(new ArtifactArgs(["--version", "0"]).sequence("version", true)).toBe(0);
  for (const raw of ["0", "-1", "1.5", "1e2", " 2"])
    expect(() => new ArtifactArgs([`--version=${raw}`]).sequence()).toThrow(
      "--version requires an integer at least 1",
    );
  expect(() => new ArtifactArgs([]).sequence()).toThrow("--version is required");
});

test("metadata() splits on the first '=' and requires a non-empty key", () => {
  expect(new ArtifactArgs(["--meta", "a=b=c", "--meta", "d="]).metadata()).toEqual({
    a: "b=c",
    d: "",
  });
  expect(() => new ArtifactArgs(["--meta", "=v"]).metadata()).toThrow("--meta requires key=value");
  expect(() => new ArtifactArgs(["--meta", "novalue"]).metadata()).toThrow(
    "--meta requires key=value",
  );
});

test("id() reports a missing positional identifier", () => {
  expect(() => new ArtifactArgs([]).id()).toThrow("Missing identifier");
  expect(new ArtifactArgs(["x", "y"]).id(1)).toBe("y");
});
