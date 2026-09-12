// Retained read-progress identities; persistence lives in artifact-hooks.ts.
export const diffViewedKey = (seq: number, path: string) => `d:${seq}:${path}`;
export const fileViewedKey = (path: string, sha: string) => `f:${path}@${sha}`;
