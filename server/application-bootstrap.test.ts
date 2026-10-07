import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREVIEW_RESUME_COOKIE } from "../shared/preview-resume.ts";
import type { ApplicationBootstrap } from "../shared/types.ts";
import { createApplicationResponse } from "./application-assets.ts";
import { createArtifactApi } from "./artifact-api.ts";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";
import { ArtifactError } from "./artifact-validation.ts";
import { COOKIE_NAME } from "./auth.ts";
import { PreviewHost } from "./preview-host.ts";
import { previewSupport } from "./preview-support.ts";

let root: string;
let storage: ArtifactStorage;
let api: ReturnType<typeof createArtifactApi>;
let respond: ReturnType<typeof createApplicationResponse>;
let token: string;
let cookie: string;
let tokenId: string;
let artifactId: string;
let previews: PreviewHost;
const title = "</script><script>window.injected=true</script><!-- $& $` $' </head>";
const shell =
  '<!doctype html><html><head><title>r3</title></head><body><div id="root"></div></body></html>';
const request = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Request(`http://localhost${path}`, { method, headers: { host: "localhost", ...headers } });
const snapshot = (html: string): ApplicationBootstrap | null => {
  const json = /<script id="r3-bootstrap" type="application\/json">(.*?)<\/script>/s.exec(
    html,
  )?.[1];
  return json ? JSON.parse(json) : null;
};
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-bootstrap-"));
  storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
  previews = new PreviewHost(storage.artifacts, previewSupport);
  token = randomBytes(32).toString("base64url");
  const login = storage.authentication.createLoginToken("bootstrap fixture");
  tokenId = login.info.id;
  cookie = `${COOKIE_NAME}=${storage.authentication.mintSession(tokenId).cookieValue}`;
  artifactId = storage.artifacts.create({
    kind: "html",
    title,
    actor: { role: "human", sessionId: null },
  }).id;
  setup(true);
});
function setup(requireLogin: boolean) {
  api?.close();
  api = createArtifactApi(
    storage,
    {
      token,
      requireLogin,
      version: "test",
      allowedHost: (host) => host === "localhost",
      applicationOrigins: new Set(["https://reviews.example"]),
    },
    { previews },
  );
  respond = createApplicationResponse(
    {
      index: {
        body: new Blob([shell.replace("</body>", `${"<!-- fixture -->".repeat(100)}</body>`)]),
        contentType: "text/html",
        etag: '"shell"',
      },
      files: new Map([
        [
          "/fixture.js",
          { body: new Blob(["void 0"]), contentType: "text/javascript", etag: '"asset"' },
        ],
      ]),
    },
    api.bootstrap,
  );
}
afterEach(async () => {
  api.close();
  previews.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
});

test("authenticated HTML embeds the API detail safely, privately, without reusable validators", async () => {
  const r = await respond(request(`/${artifactId}`, { cookie, "if-none-match": '"shell"' }));
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("private, no-store");
  expect(r.headers.has("etag")).toBe(false);
  expect(r.headers.get("x-frame-options")).toBe("DENY");
  expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  const html = await r.text();
  expect(html).not.toContain(token);
  expect(html).not.toContain("<script>window.injected");
  const data = snapshot(html)!;
  expect(data.boot).toEqual({ needsAuth: false, token: null });
  expect(data.artifact?.title).toBe(title);
  const detail = await api.app.fetch(request(`/api/artifacts/${artifactId}`, { cookie }));
  expect(data.artifact).toEqual(await detail.json());
  const zipped = await respond(request(`/${artifactId}`, { cookie, "accept-encoding": "gzip" }));
  expect(zipped.headers.get("content-encoding")).toBe("gzip");
  expect(snapshot(new TextDecoder().decode(Bun.gunzipSync(await zipped.arrayBuffer())))).toEqual(
    data,
  );
  const head = await respond(request(`/${artifactId}`, { cookie }, "HEAD"));
  expect(await head.text()).toBe("");
  expect(Number(head.headers.get("content-length"))).toBeGreaterThan(0);
});

test("cross-site, opaque, missing, and revoked credentials cannot acquire shell data", async () => {
  const cases: Record<string, string>[] = [
    {},
    { cookie, origin: "null" },
    { cookie, origin: "https://outside.example" },
    { cookie, "sec-fetch-site": "cross-site" },
    { cookie, "sec-fetch-site": "same-site" },
    { cookie, host: "untrusted.example" },
  ];
  for (const headers of cases) {
    const response = await respond(request(`/${artifactId}`, headers));
    expect(snapshot(await response.text())).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  }
  expect(
    api.bootstrap(request(`/${artifactId}`, { cookie, origin: "https://reviews.example" }))
      ?.artifact?.id,
  ).toBe(artifactId);
  storage.authentication.revokeToken(tokenId);
  const revoked = await respond(request(`/${artifactId}`, { cookie, "if-none-match": '"shell"' }));
  expect(revoked.status).toBe(200);
  expect(snapshot(await revoked.text())).toBeNull();
  expect((await api.app.fetch(request(`/api/artifacts/${artifactId}`, { cookie }))).status).toBe(
    401,
  );
});

test("local bootstrap keeps its origin boundary and non-document assets stay immutable", async () => {
  setup(false);
  expect(snapshot(await (await respond(request("/"))).text())?.boot.token).toBe(token);
  expect(
    snapshot(await (await respond(request("/", { "sec-fetch-site": "cross-site" }))).text()),
  ).toBeNull();
  expect(snapshot(await (await respond(request("/", { origin: "null" }))).text())).toBeNull();
  expect(snapshot(await (await respond(request("/artifact_missing"))).text())?.artifact).toBeNull();
  expect((await respond(request("/artifact_missing/other"))).status).toBe(404);
  expect((await respond(request("/", {}, "POST"))).status).toBe(405);
  const asset = await respond(request("/fixture.js", { "if-none-match": '"asset"' }));
  expect(asset.status).toBe(304);
  expect(asset.headers.get("cache-control")).toContain("immutable");
});

const agent = (sessionId: string) => ({ role: "agent" as const, sessionId });
const file = (path: string, text: string) => ({
  path,
  mediaType: "text/html",
  base64: Buffer.from(text).toString("base64"),
});
async function publish(
  seq: number,
  files = [file("index.html", `Version ${seq}`)],
  id = artifactId,
) {
  return storage.artifacts.publish(id, {
    actor: { role: "human", sessionId: null },
    expectedSeq: seq - 1,
    publicationKey: `version-${seq}`,
    content: { kind: "html", files },
  });
}

test("bootstrap embeds only the selected immutable HTML manifest, with bounded fallback", async () => {
  await publish(1);
  await publish(2);
  const read = (search = "") => api.bootstrap(request(`/${artifactId}${search}`, { cookie }))!;
  expect(read("?version=1").manifest).toEqual({
    versionSeq: 1,
    files: storage.artifacts.files(artifactId, 1),
  });
  expect(read().manifest).toEqual({ versionSeq: 2, files: storage.artifacts.files(artifactId, 2) });
  expect(read("?version=invalid").manifest?.versionSeq).toBe(2);
  expect(read("?version=99").manifest).toBeNull();
  await publish(3, [
    file("index.html", "Large directory"),
    ...Array.from({ length: 128 }, (_, i) => file(`page-${i}.html`, "Companion")),
  ]);
  expect(read().manifest).toBeNull();
  expect(read("?version=1").manifest?.versionSeq).toBe(1);
});

test("HTML prepares exact-version restrictive contexts after auth, with no external grant", async () => {
  await publish(1);
  await publish(2);
  const prepared = api.bootstrap(request(`/${artifactId}?version=1`, { cookie }))!.preview!;
  expect(prepared.applicationOrigin).toBe("https://reviews.example");
  const [blocked, compatible] = prepared.contexts;
  expect(blocked).toMatchObject({ artifactId, versionSeq: 1, network: "blocked" });
  expect(compatible).toMatchObject({ artifactId, versionSeq: 1, network: "compatible" });
  expect(blocked.origin).toBe(prepared.applicationOrigin);
  expect(prepared.retained).toBe(false);
  expect(blocked.id).not.toBe(compatible.id);
  expect(api.bootstrap(request(`/${artifactId}?version=99`, { cookie }))!.preview).toBeNull();
  expect(api.bootstrap(request(`/${artifactId}`, { cookie }, "HEAD"))!.preview).toBeNull();
  expect(api.bootstrap(request(`/${artifactId}`, { cookie, origin: "null" }))).toBeNull();
  expect(api.bootstrap(request(`/${artifactId}`))).toBeNull();
  const local = api.bootstrap(request(`/${artifactId}`, { cookie, origin: "http://localhost" }))!;
  expect(local.preview?.applicationOrigin).toBe("http://localhost");
  expect(local.preview?.contexts[0].versionSeq).toBe(2);
  storage.authentication.revokeToken(tokenId);
  expect(api.bootstrap(request(`/${artifactId}`, { cookie }))).toBeNull();
});

test("authenticated navigation resumes hinted scopes without replacing their URLs", async () => {
  await publish(1);
  await publish(2);
  const headers = { cookie };
  const selected = api.bootstrap(request(`/${artifactId}?version=1`, headers))!.preview!
    .contexts[1];
  const hinted = `${cookie}; ${PREVIEW_RESUME_COOKIE}=${selected.resumeKey}`;
  const result = api.bootstrap(request(`/${artifactId}?version=1`, { cookie: hinted }))!.preview!;
  expect(result.retained).toBe(true);
  expect(result.contexts).toHaveLength(1);
  expect(result.contexts[0].documentUrl).toBe(selected.documentUrl);
  expect(result.contexts[0].resourceRoot).toBe(selected.resourceRoot);
  // The hint cannot authenticate the HTML request or select another version.
  expect(
    api.bootstrap(
      request(`/${artifactId}`, { cookie: `${PREVIEW_RESUME_COOKIE}=${selected.resumeKey}` }),
    ),
  ).toBeNull();
  const newer = api.bootstrap(request(`/${artifactId}?version=2`, { cookie: hinted }))!.preview!;
  expect(newer.retained).toBe(false);
  expect(newer.contexts[0].versionSeq).toBe(2);
  expect(newer.contexts[0].id).not.toBe(selected.id);
  expect(api.bootstrap(request(`/${artifactId}`, { cookie: hinted, origin: "null" }))).toBeNull();
  previews.revoke(selected.id);
  const revoked = api.bootstrap(request(`/${artifactId}?version=1`, { cookie: hinted }))!.preview!;
  expect(revoked.retained).toBe(false);
  expect(revoked.contexts.every((context) => context.id !== selected.id)).toBe(true);
});

test("unavailable optional preview preparation leaves the authenticated workspace usable", async () => {
  await publish(1);
  previews.contexts.prepare = () => {
    throw new ArtifactError("Too many open preview contexts", 413);
  };
  const data = snapshot(await (await respond(request(`/${artifactId}`, { cookie }))).text())!;
  expect(data.artifact?.id).toBe(artifactId);
  expect(data.manifest?.versionSeq).toBe(1);
  expect(data.preview).toBeNull();
});

test("artifact labels include every referenced role, omit unrelated sessions, and stay current", async () => {
  for (const id of [
    "creator",
    "publisher",
    "commenter",
    "reply",
    "claim",
    "lifecycle",
    "unrelated",
    "__proto__",
  ])
    storage.artifacts.registerSession({ id, label: id === "creator" ? title : `Label ${id}` });
  artifactId = storage.artifacts.create({ kind: "html", actor: agent("creator") }).id;
  await storage.artifacts.publish(artifactId, {
    actor: agent("publisher"),
    expectedSeq: 0,
    publicationKey: "first",
    content: { kind: "html", files: [file("index.html", "Preview")] },
  });
  const note = await storage.conversations.add(artifactId, {
    actor: agent("commenter"),
    body: "Feedback",
    target: { kind: "artifact" },
  });
  await storage.conversations.addReply(note.id, {
    actor: agent("reply"),
    body: "Reply",
    context: { versionSeq: null, representation: null },
  });
  await storage.conversations.addReply(note.id, {
    actor: agent("__proto__"),
    body: "Another reply",
    context: { versionSeq: null, representation: null },
  });
  storage.lifecycle.transition(artifactId, {
    actor: agent("lifecycle"),
    event: "archived",
    operationKey: "archive",
  });
  storage.lifecycle.transition(artifactId, {
    actor: agent("lifecycle"),
    event: "restored",
    operationKey: "restore",
  });
  storage.conversations.claim([note.id], "claim");
  const response = await respond(request(`/${artifactId}`, { cookie }));
  const html = await response.text();
  expect(html).not.toContain("<script>window.injected");
  const labels = snapshot(html)!.artifact!.agentLabels!;
  expect(Object.keys(labels).sort()).toEqual([
    "__proto__",
    "claim",
    "commenter",
    "creator",
    "lifecycle",
    "publisher",
    "reply",
  ]);
  expect(labels.creator).toBe(title);
  expect(labels.__proto__).toBe("Label __proto__");
  storage.artifacts.registerSession({ id: "creator", label: "Updated publisher name" });
  const detail = await api.app.fetch(request(`/api/artifacts/${artifactId}`, { cookie }));
  expect((await detail.json()).agentLabels.creator).toBe("Updated publisher name");
  expect(
    snapshot(await (await respond(request(`/${artifactId}`, { cookie }))).text())!.artifact!
      .agentLabels!.creator,
  ).toBe("Updated publisher name");
});
