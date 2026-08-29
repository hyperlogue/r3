import { describe, expect, test } from "bun:test";

// setHighlightRanges is a small state machine over the highlight registry: it
// remembers what each name holds so the region pass — which re-derives the same
// ranges on every content mutation — doesn't rebuild a Highlight for nothing.
// Getting it wrong is invisible to tsc and silent at runtime (a highlight that
// stops following the anchor), which is what earns a test. The DOM isn't needed
// to state the rule: the only thing it reads off a Range is its four boundary
// primitives, so a plain object stands in for one. Install the two globals
// `registry()` probes before importing — it reads them per call, so the module
// is otherwise inert at import time.
const calls: string[] = [];
Object.assign(globalThis, {
  CSS: {
    highlights: {
      set(name: string) {
        calls.push(`set:${name}`);
      },
      delete(name: string) {
        calls.push(`del:${name}`);
        return true;
      },
    },
  },
  // `new Highlight(...ranges)` just has to construct; extra args are ignored.
  Highlight: class {},
});

const { setHighlightRanges } = await import("./mdhighlight.ts");

// Two stand-in text nodes to hang boundaries off; only their identity matters.
const nodeA = {} as Node;
const nodeB = {} as Node;

// A fresh object each call, deliberately: the pass allocates new Ranges every
// time, so "identical" has to mean same boundaries, never same object.
function range(start: Node, so: number, end: Node, eo: number): Range {
  return { startContainer: start, startOffset: so, endContainer: end, endOffset: eo } as Range;
}

describe("setHighlightRanges", () => {
  test("skips a re-register of the same boundaries, not of changed ones", () => {
    calls.length = 0;
    setHighlightRanges("a", [range(nodeA, 0, nodeA, 4)]);
    setHighlightRanges("a", [range(nodeA, 0, nodeA, 4)]);
    expect(calls).toEqual(["set:a"]);

    // A moved offset, a different node, and an added range all have to land.
    setHighlightRanges("a", [range(nodeA, 1, nodeA, 4)]);
    setHighlightRanges("a", [range(nodeB, 1, nodeB, 4)]);
    setHighlightRanges("a", [range(nodeB, 1, nodeB, 4), range(nodeA, 0, nodeA, 2)]);
    expect(calls).toEqual(["set:a", "set:a", "set:a", "set:a"]);
  });

  test("clears once, then stays quiet", () => {
    calls.length = 0;
    setHighlightRanges("b", [range(nodeA, 0, nodeA, 4)]);
    setHighlightRanges("b", []);
    setHighlightRanges("b", []);
    expect(calls).toEqual(["set:b", "del:b"]);
  });

  test("clears a name it has never written (the registry's state is unknown)", () => {
    calls.length = 0;
    setHighlightRanges("c", []);
    expect(calls).toEqual(["del:c"]);
  });
});
