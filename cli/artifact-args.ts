export class ArtifactCommandError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

const BOOLEAN = new Set([
  "json",
  "human",
  "all",
  "mine",
  "stdin-diff",
  "working",
  "staged",
  "foreground",
  "no-listen",
]);
const VALUE = new Set([
  "kind",
  "title",
  "summary",
  "dir",
  "file",
  "ref",
  "commit",
  "diff",
  "label",
  "version-label",
  "key",
  "expected",
  "project",
  "meta",
  "state",
  "version",
  "view",
  "target",
  "line",
  "quote",
  "side",
  "selector",
  "route",
  "session",
  "message",
  "status",
  "feedback",
  "timeout",
  "remote",
]);
const REPEATED = new Set(["file", "meta"]);
export class ArtifactArgs {
  readonly positional: string[] = [];
  private readonly flags = new Map<string, string[]>();
  constructor(argv: string[]) {
    for (let i = 0; i < argv.length; i++) {
      let token = argv[i];
      if (token === "--") {
        this.positional.push(...argv.slice(i + 1));
        break;
      }
      if (token === "-m") token = "--message";
      if (!token.startsWith("--")) {
        if (token.startsWith("-") && token !== "-")
          throw new ArtifactCommandError(`Unknown option: ${token}`);
        this.positional.push(token);
        continue;
      }
      const [name, ...rest] = token.slice(2).split("=");
      let value = rest.length ? rest.join("=") : undefined;
      if (BOOLEAN.has(name)) {
        if (value !== undefined) throw new ArtifactCommandError(`--${name} does not take a value`);
        value = "true";
      } else if (VALUE.has(name)) {
        if (value === undefined) {
          value = argv[++i];
          if (value === undefined || value.startsWith("--"))
            throw new ArtifactCommandError(`--${name} requires a value`);
        }
      } else throw new ArtifactCommandError(`Unknown option: --${name}`);
      const held = this.flags.get(name) ?? [];
      if (held.length && !REPEATED.has(name))
        throw new ArtifactCommandError(`--${name} may only be specified once`);
      this.flags.set(name, [...held, value]);
    }
  }
  has(name: string) {
    return this.flags.has(name);
  }
  allow(names: string[]) {
    const allowed = new Set(["json", "human", "session", ...names]);
    for (const name of this.flags.keys())
      if (!allowed.has(name))
        throw new ArtifactCommandError(`--${name} is not supported by this command`);
  }
  value(name: string) {
    return this.flags.get(name)?.[0];
  }
  values(name: string) {
    return this.flags.get(name) ?? [];
  }
  require(name: string) {
    const value = this.value(name);
    if (!value) throw new ArtifactCommandError(`--${name} is required`);
    return value;
  }
  id(index = 0) {
    const value = this.positional[index];
    if (!value) throw new ArtifactCommandError("Missing identifier");
    return value;
  }
  sequence(name = "version", allowZero = false) {
    const raw = this.require(name);
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1))
      throw new ArtifactCommandError(
        `--${name} requires an integer ${allowZero ? "at least 0" : "at least 1"}`,
      );
    return value;
  }
  metadata(): Record<string, string> {
    const pairs = this.values("meta").map((pair) => {
      const at = pair.indexOf("=");
      if (at < 1) throw new ArtifactCommandError("--meta requires key=value");
      return [pair.slice(0, at), pair.slice(at + 1)];
    });
    return Object.fromEntries(pairs);
  }
}
