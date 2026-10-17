// The production application with test-only access to its existing client/store.
import { R3_VERSION } from "../shared/version.ts";
import { api } from "../web/src/api.ts";
import { applicationFetch } from "../web/src/application-fetch.ts";
import { artifactApi } from "../web/src/artifact-api.ts";
import { artifactDrafts } from "../web/src/artifact-drafts.ts";
import "../web/src/main.tsx";

Object.assign(window, {
  versionFixture: {
    version: R3_VERSION,
    request: applicationFetch,
    themes: api.themes,
    list: artifactApi.list,
    draft: (id: string) => artifactDrafts.get(id),
    editDraft: (id: string, body: string) => artifactDrafts.update(id, { body }),
  },
});
