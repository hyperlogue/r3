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
    "?q=keyboard&project=project_one&kind=files&view=archived&history=all&type=conversation&sort=title&offset=50",
  );
  expect(readLibraryState(librarySearch(state))).toEqual(state);
  expect(libraryReturnRoute(`?library=${encodeURIComponent(librarySearch(state))}`)).toBe(
    `/${librarySearch(state)}`,
  );
  expect(libraryReturnRoute("?library=https%3A%2F%2Fexample.com")).toBe("/");
  expect(readLibraryState("?offset=Infinity&kind=unknown").offset).toBe(0);
  expect(readLibraryState("").view).toBe("active");
  expect(readLibraryState("?view=attention").view).toBe("active");
  expect(librarySearch(readLibraryState("?view=all"))).toBe("?view=all");
});

test("library defaults to active artifacts and attention sorting outranks live presence", () => {
  const archived = { ...artifactFixture, id: "archived", state: "archived" as const };
  const working = { ...artifactFixture, id: "working", unhandledCount: 0, working: true };
  const attention = { ...artifactFixture, id: "attention" };
  expect(
    filterLibrary([working, archived, attention], readLibraryState("?sort=attention")).map(
      (a) => a.id,
    ),
  ).toEqual(["attention", "working"]);
  expect(
    filterLibrary([working, archived, attention], readLibraryState("?view=archived")).map(
      (a) => a.id,
    ),
  ).toEqual(["archived"]);
  expect(
    filterLibrary([working, archived, attention], readLibraryState("?view=all&sort=attention")).map(
      (a) => a.id,
    ),
  ).toEqual(["attention", "working", "archived"]);
});

test("search links preserve publication and return filters without private reading state", () => {
  const route = artifactLibraryRoute(artifactFixture, readLibraryState("?q=keyboard&history=all"), {
    id: "comment_match",
    artifactId: artifactFixture.id,
    category: "comment",
    versionSeq: 2,
    context: { versionSeq: 2, representation: "rendered" },
    path: null,
    target: null,
    threadId: "thread_original",
    commentId: "comment_match",
    snippet: "Keyboard fix",
  });
  const params = new URLSearchParams(route.split("?")[1]);
  expect(params.get("version")).toBe("2");
  expect([...params.keys()]).toEqual(["library", "version"]);
  expect(params.get("library")).toBe("?q=keyboard&history=all");
});
