import { expect, test } from "bun:test";
import { artifactFixture } from "./artifact-fixtures.ts";
import {
  artifactLibraryRoute,
  filterLibrary,
  libraryReturnRoute,
  librarySearch,
  readLibraryState,
} from "./artifact-library.ts";

test("library query round trips filters and rejects unsafe return routes", () => {
  const state = readLibraryState(
    "?q=keyboard&project=project_one&kind=files&view=attention&history=all&type=conversation&sort=title&offset=50",
  );
  expect(readLibraryState(librarySearch(state))).toEqual(state);
  expect(libraryReturnRoute(`?library=${encodeURIComponent(librarySearch(state))}`)).toBe(
    `/${librarySearch(state)}`,
  );
  expect(libraryReturnRoute("?library=https%3A%2F%2Fexample.com")).toBe("/");
  expect(readLibraryState("?offset=Infinity&kind=unknown").offset).toBe(0);
});

test("attention excludes archived artifacts and outranks live presence", () => {
  const archived = { ...artifactFixture, id: "archived", state: "archived" as const };
  const working = { ...artifactFixture, id: "working", unhandledCount: 0, working: true };
  const attention = { ...artifactFixture, id: "attention" };
  expect(
    filterLibrary([working, archived, attention], readLibraryState("?sort=attention")).map(
      (a) => a.id,
    ),
  ).toEqual(["attention", "working", "archived"]);
  expect(
    filterLibrary([working, archived, attention], readLibraryState("?view=attention")).map(
      (a) => a.id,
    ),
  ).toEqual(["attention"]);
});

test("comment links preserve the comment context independently of the original concern", () => {
  const route = artifactLibraryRoute(artifactFixture, readLibraryState("?q=keyboard&history=all"), {
    id: "comment_match",
    artifactId: artifactFixture.id,
    category: "comment",
    versionSeq: 2,
    context: { versionSeq: 2, representation: "rendered" },
    path: null,
    target: null,
    discussionId: "discussion_original",
    commentId: "comment_match",
    snippet: "Keyboard fix",
  });
  const params = new URLSearchParams(route.split("?")[1]);
  expect(params.get("version")).toBe("2");
  expect(params.get("view")).toBe("rendered");
  expect(params.get("comment")).toBe("comment_match");
  expect(params.get("file")).toBeNull();
  expect(params.get("library")).toBe("?q=keyboard&history=all");
});
