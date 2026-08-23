import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./highlight.ts";
import { isMermaidFence, renderMermaidSvg } from "./mermaid.ts";

const FLOW = `flowchart LR
  subgraph tui [Dashboard process]
    Key[Keymap / Space p / comma] --> Prefs[InputMode::Prefs]
    Prefs --> Catalog[Pref catalog]
    Catalog --> Apply[App::apply_pref]
    Apply --> OvWrite["write_json_atomic dashboard-overrides.json"]
    Toml["config.toml (read-only)"] --> Merge[merge: default then TOML then overrides]
    OvWrite --> Merge
    Merge --> Get["config::get() per frame"]
    Get --> Draw[draw.rs / format.rs]
    Apply --> AppFields["App.keymap / on_window_close / new_session_agent / …"]
    Toml --> Watcher["notify RecommendedWatcher"]
    Watcher --> Reload[reload TOML + re-merge]
    Reload --> Get
  end
  subgraph other [Other processes]
    Toml -.->|next spawn, their file| Launchers[launcher OnceLock]
    HM["home-manager switch / $EDITOR"] --> Toml
  end
`;

const SEQUENCE = `sequenceDiagram
    participant A as Agent
    participant S as r3 server
    participant U as You (browser)

    A->>S: [1] r3 create — opens a review
    loop until you Approve or Abandon
        A->>S: [2] r3 watch
        U->>S: [3] leave feedback + Submit
        S-->>A: watch prints feedback
    end
`;

describe("isMermaidFence", () => {
  test("matches mermaid and mmd info words, not other grammars", () => {
    expect(isMermaidFence("mermaid")).toBe(true);
    expect(isMermaidFence("mmd")).toBe(true);
    expect(isMermaidFence("mermaid {align=center}")).toBe(true);
    expect(isMermaidFence("ts")).toBe(false);
    expect(isMermaidFence("")).toBe(false);
  });
});

describe("renderMermaidSvg", () => {
  test("renders a flowchart with subgraphs, quoted labels, and dotted edges", () => {
    const svg = renderMermaidSvg("mermaid", FLOW);
    expect(svg).toBeTruthy();
    expect(svg).toContain("<svg");
    expect(svg).toContain("Dashboard process");
    expect(svg).toContain("Other processes");
    expect(svg).toContain("InputMode::Prefs");
    expect(svg).toContain("write_json_atomic");
    expect(svg).toContain("config.toml");
    expect(svg).toContain("home-manager");
    expect(svg).toContain("launcher OnceLock");
    expect(svg).toContain("next spawn, their file");
    expect(svg).toContain("r3-mmd-dotted");
  });

  test("renders a sequence diagram with aliases, loops, and dashed replies", () => {
    const svg = renderMermaidSvg("mermaid", SEQUENCE);
    expect(svg).toBeTruthy();
    expect(svg).toContain("Agent");
    expect(svg).toContain("r3 server");
    expect(svg).toContain("You (browser)");
    expect(svg).toContain("until you Approve or Abandon");
    expect(svg).toContain("r3 watch");
    expect(svg).toContain("r3-mmd-dotted");
  });

  test("escapes HTML in node labels so a fence cannot inject markup", () => {
    const svg = renderMermaidSvg(
      "mermaid",
      'flowchart LR\n  A["<script>alert(1)</script>"] --> B["foo & bar"]\n',
    );
    expect(svg).toBeTruthy();
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
    expect(svg).toContain("foo &amp; bar");
  });

  test("returns null for unsupported diagrams so the fence stays source", () => {
    expect(renderMermaidSvg("mermaid", 'pie title Pets\n  "dogs" : 10\n')).toBeNull();
    expect(renderMermaidSvg("ts", FLOW)).toBeNull();
    expect(renderMermaidSvg("mermaid", "")).toBeNull();
    expect(renderMermaidSvg("mermaid", "flowchart LR\n")).toBeNull();
  });

  test("accepts graph TD as a flowchart", () => {
    const svg = renderMermaidSvg("mermaid", "graph TD\n  A-->B-->C\n");
    expect(svg).toContain(">A</text>");
    expect(svg).toContain(">B</text>");
    expect(svg).toContain(">C</text>");
  });

  test("keeps hyphenated ids while still splitting A-->B", () => {
    const svg = renderMermaidSvg("mermaid", "flowchart LR\n  my-node-->other\n");
    expect(svg).toContain("my-node");
    expect(svg).toContain("other");
  });

  test("nested subgraphs keep inner nodes and both titles", () => {
    const svg = renderMermaidSvg(
      "mermaid",
      `flowchart LR
        subgraph outer [Outer]
          A[A] --> B[B]
          subgraph inner [Inner]
            C[C] --> D[D]
          end
          B --> C
        end
      `,
    );
    expect(svg).toContain("Outer");
    expect(svg).toContain("Inner");
    expect(svg).toContain(">A</text>");
    expect(svg).toContain(">B</text>");
    expect(svg).toContain(">C</text>");
    expect(svg).toContain(">D</text>");
  });
});

describe("renderMarkdown mermaid fences", () => {
  test("wraps a flowchart fence in .r3-mermaid with source-line attrs", async () => {
    const html = await renderMarkdown(
      "intro\n\n```mermaid\nflowchart LR\n  A-->B\n```\n",
      "doc.md",
    );
    expect(html).toContain('class="r3-mermaid"');
    expect(html).toContain("data-line-start");
    expect(html).toContain("<svg");
    expect(html).toContain("A");
    expect(html).toContain("B");
    expect(html).not.toContain("language-mermaid");
  });

  test("falls through to a highlighted code fence for pie charts", async () => {
    const html = await renderMarkdown('```mermaid\npie title Pets\n  "dogs" : 10\n```\n', "doc.md");
    expect(html).not.toContain("r3-mermaid");
    expect(html).toContain("language-mermaid");
  });
});
