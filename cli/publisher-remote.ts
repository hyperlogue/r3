import { type GitRemote, normalizeGitRemote } from "../shared/git-remote.ts";
import { publisherGit } from "./capture-git.ts";

export interface PublisherRemote {
  remote: GitRemote | null;
  warning?: string;
}

// Git stays on the publisher. Never echo configuration, URLs, or Git stderr:
// they can contain credentials even when inference fails.
export async function detectPublisherRemote(cwd: string): Promise<PublisherRemote> {
  try {
    const listed = await publisherGit(cwd, ["remote"]);
    if (listed.code !== 0) return { remote: null };
    const names = listed.stdout.toString().trim().split("\n").filter(Boolean);
    if (!names.length) return { remote: null };
    let name = names.includes("origin") ? "origin" : undefined;
    if (!name) {
      const branch = await publisherGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      if (branch.code === 0) {
        const configured = await publisherGit(cwd, [
          "config",
          "--get",
          `branch.${branch.stdout.toString().trim()}.remote`,
        ]);
        const upstream = configured.stdout.toString().trim();
        if (configured.code === 0 && names.includes(upstream)) name = upstream;
      }
      if (!name && names.length === 1) name = names[0];
    }
    if (!name)
      return {
        remote: null,
        warning: "Project inference skipped: multiple Git remotes; choose --project.",
      };
    const result = await publisherGit(cwd, ["remote", "get-url", "--all", "--", name]);
    const urls = [...new Set(result.stdout.toString().trim().split("\n").filter(Boolean))];
    if (result.code !== 0 || urls.length !== 1)
      return {
        remote: null,
        warning: "Project inference skipped: the selected remote has no unique fetch URL.",
      };
    const remote = normalizeGitRemote(urls[0]);
    return remote
      ? { remote }
      : {
          remote: null,
          warning:
            "Project inference skipped: the selected remote is not a supported network Git URL.",
        };
  } catch {
    return {
      remote: null,
      warning: "Project inference unavailable; use --project for explicit grouping.",
    };
  }
}
