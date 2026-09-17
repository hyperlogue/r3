import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ArtifactProjects } from "./artifact-projects.ts";
import { createArtifactTables } from "./artifact-schema.ts";

let db: Database;
let projects: ArtifactProjects;
const clock = () => "2026-09-01T00:00:00.000Z";
beforeEach(() => {
  db = new Database(":memory:");
  createArtifactTables(db);
  projects = new ArtifactProjects(db, clock);
});
afterEach(() => db.close());

test("equivalent remotes reuse one project, while explicit groups and null override inference", () => {
  const id = projects.resolve({ remoteUrl: "git@code.example:team/repo.git" })!;
  expect(projects.resolve({ remoteUrl: "https://code.example/team/repo" })).toBe(id);
  expect(projects.list()).toHaveLength(1);
  expect(projects.get(id).name).toBe("repo");
  const explicit = projects.create({ name: "Explicit" });
  expect(
    projects.resolve({ projectId: explicit.id, remoteUrl: "https://code.example/other/repo" }),
  ).toBe(explicit.id);
  expect(
    projects.resolve({ projectId: null, remoteUrl: "https://code.example/team/repo" }),
  ).toBeNull();
  expect(projects.list()).toHaveLength(2);
});

test("backfill is conditional, rejects collisions, and preserves prior metadata on failure", () => {
  const old = projects.create({ id: "existing-project", name: "Existing" });
  const remoteUrl = "https://code.example/team/repo.git";
  expect(projects.edit(old.id, { remoteUrl, expectedRemoteUrl: null })).toEqual({
    ...old,
    remoteUrl,
  });
  expect(projects.resolve({ remoteUrl: "ssh://code.example/team/repo" })).toBe(old.id);
  expect(() => projects.edit(old.id, { remoteUrl: null, expectedRemoteUrl: null })).toThrow(
    "changed",
  );
  const other = projects.create({ name: "Other" });
  expect(() => projects.edit(other.id, { name: "Changed", remoteUrl })).toThrow("already belongs");
  expect(projects.get(other.id)).toEqual(other);
  projects.delete(old.id);
  expect(db.query("SELECT * FROM project_remotes").all()).toEqual([]);
});

test("manual mode disables inference and explicit alias mappings override it only in remote mode", () => {
  const target = projects.create({ name: "Mapped" });
  const mappings = { "https://alias.example/team/repo": target.id };
  const mapped = new ArtifactProjects(db, clock, { mappings });
  expect(mapped.resolve({ remoteUrl: "git@alias.example:team/repo.git" })).toBe(target.id);
  const manual = new ArtifactProjects(db, clock, { mode: "manual", mappings });
  expect(manual.resolve({ remoteUrl: "https://alias.example/team/repo" })).toBeNull();
  expect(manual.resolve({ projectId: target.id })).toBe(target.id);
  expect(projects.list()).toHaveLength(1);
});

test("existing remote metadata is reused and duplicate historical groups need explicit choice", () => {
  const insert = db.query(
    "INSERT INTO projects(id,name,remote_url,created_at) VALUES (?,NULL,?,?)",
  );
  insert.run("legacy-a", "git@code.example:team/repo.git", clock());
  expect(projects.resolve({ remoteUrl: "https://code.example/team/repo" })).toBe("legacy-a");
  db.query("DELETE FROM project_remotes").run();
  insert.run("legacy-b", "https://code.example/team/repo", clock());
  expect(() => projects.resolve({ remoteUrl: "https://code.example/team/repo" })).toThrow(
    "multiple projects",
  );
  expect(projects.resolve({ projectId: "legacy-b" })).toBe("legacy-b");
});
