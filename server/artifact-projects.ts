import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { ArtifactProject } from "../shared/artifacts.ts";
import { normalizeGitRemote } from "../shared/git-remote.ts";
import {
  ArtifactError,
  optionalText,
  requireObject,
  requireString,
} from "./artifact-validation.ts";

export interface ProjectGroupingOptions {
  mode?: "remote" | "manual";
  mappings?: Record<string, string>;
}

const COLUMNS = "SELECT id, name, remote_url AS remoteUrl, created_at AS createdAt FROM projects";

export class ArtifactProjects {
  private readonly mappings = new Map<string, string>();
  constructor(
    private readonly db: Database,
    private readonly clock: () => string,
    private readonly options: ProjectGroupingOptions = {},
  ) {
    for (const [url, id] of Object.entries(options.mappings ?? {})) {
      const remote = normalizeGitRemote(url);
      if (!remote || typeof id !== "string" || !id || id.length > 200)
        throw new Error("Invalid project remote mapping");
      const previous = this.mappings.get(remote.key);
      if (previous && previous !== id) throw new Error("Conflicting project remote mappings");
      this.mappings.set(remote.key, id);
    }
  }

  list(): ArtifactProject[] {
    return this.db.query<ArtifactProject, []>(`${COLUMNS} ORDER BY name, id`).all();
  }

  get(id: string): ArtifactProject {
    const project = this.db.query<ArtifactProject, [string]>(`${COLUMNS} WHERE id = ?`).get(id);
    if (!project) throw new ArtifactError("Project not found", 404);
    return project;
  }

  private remote(value: unknown) {
    if (value === undefined || value === null) return null;
    const remote = normalizeGitRemote(value);
    if (!remote) throw new ArtifactError("Project remote must be a network Git URL");
    return remote;
  }

  private link(id: string, url: string | null): void {
    const remote = url ? this.remote(url) : null;
    if (remote) {
      const owner = this.db
        .query<{ project_id: string }, [string]>(
          "SELECT project_id FROM project_remotes WHERE remote_key = ?",
        )
        .get(remote.key);
      const other = this.list().some(
        (project) => project.id !== id && normalizeGitRemote(project.remoteUrl)?.key === remote.key,
      );
      if ((owner && owner.project_id !== id) || other)
        throw new ArtifactError(
          "Remote already belongs to another project; use an explicit project mapping",
          409,
        );
    }
    this.db.query("DELETE FROM project_remotes WHERE project_id = ?").run(id);
    if (remote)
      this.db
        .query("INSERT INTO project_remotes(remote_key, project_id) VALUES (?, ?)")
        .run(remote.key, id);
  }

  create(value: unknown): ArtifactProject {
    const body = requireObject(value, "Project");
    const id =
      body.id === undefined ? `project_${randomUUID()}` : requireString(body.id, "Project id", 200);
    const name = optionalText(body.name, "Project name", 1000);
    const remoteUrl = this.remote(body.remoteUrl)?.url ?? null;
    return this.db
      .transaction(() => {
        if (this.db.query("SELECT 1 FROM projects WHERE id = ?").get(id))
          throw new ArtifactError("Project id is already registered", 409);
        this.db
          .query("INSERT INTO projects(id, name, remote_url, created_at) VALUES (?, ?, ?, ?)")
          .run(id, name, remoteUrl, this.clock());
        this.link(id, remoteUrl);
        return this.get(id);
      })
      .immediate();
  }

  edit(id: string, value: unknown): ArtifactProject {
    const body = requireObject(value, "Project update");
    if (
      !Object.keys(body).length ||
      Object.keys(body).some((key) => !["name", "remoteUrl", "expectedRemoteUrl"].includes(key))
    )
      throw new ArtifactError("Project update accepts name, remoteUrl, and expectedRemoteUrl");
    return this.db
      .transaction(() => {
        const current = this.get(id);
        if ("expectedRemoteUrl" in body && body.expectedRemoteUrl !== current.remoteUrl)
          throw new ArtifactError("Project remote changed; fetch the project before retrying", 409);
        const name = "name" in body ? optionalText(body.name, "Project name", 1000) : current.name;
        const remoteUrl =
          "remoteUrl" in body ? (this.remote(body.remoteUrl)?.url ?? null) : current.remoteUrl;
        if ("remoteUrl" in body) this.link(id, remoteUrl);
        this.db
          .query("UPDATE projects SET name = ?, remote_url = ? WHERE id = ?")
          .run(name, remoteUrl, id);
        return this.get(id);
      })
      .immediate();
  }

  delete(id: string): void {
    if (!this.db.query("DELETE FROM projects WHERE id = ?").run(id).changes)
      throw new ArtifactError("Project not found", 404);
  }

  // Called inside artifact creation's transaction. Explicit null means ungrouped.
  resolve(body: Record<string, unknown>): string | null {
    const remote = this.remote(body.remoteUrl);
    if ("projectId" in body) {
      const id = optionalText(body.projectId, "projectId", 200);
      if (id !== null) this.get(id);
      return id;
    }
    if (!remote || this.options.mode === "manual") return null;
    const configured = this.mappings.get(remote.key);
    if (configured) return this.get(configured).id;
    const existing = this.db
      .query<{ project_id: string }, [string]>(
        "SELECT project_id FROM project_remotes WHERE remote_key = ?",
      )
      .get(remote.key);
    if (existing) return existing.project_id;
    const legacy = this.list().filter(
      (project) => normalizeGitRemote(project.remoteUrl)?.key === remote.key,
    );
    if (legacy.length > 1)
      throw new ArtifactError(
        "Remote matches multiple projects; choose --project or configure a mapping",
        409,
      );
    if (legacy.length === 1) {
      this.link(legacy[0].id, remote.url);
      return legacy[0].id;
    }
    return this.create({ name: remote.name, remoteUrl: remote.url }).id;
  }
}
