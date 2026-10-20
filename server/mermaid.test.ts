import { describe, expect, test } from "bun:test";
import { renderPublishedMarkdown } from "./highlight.ts";
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
        U->>S: [3] leave threads + Submit
        S-->>A: watch prints threads
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

  test("renders a sequence diagram with aliases, loops, and dashed comments", () => {
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

  test("preserves Unicode node and subgraph identities and titles", () => {
    const svg = renderMermaidSvg(
      "mermaid",
      `flowchart TD
        subgraph 世界 ["两座城市"]
          北城[北方] --> 南城[南方]
        end
      `,
    );
    expect(svg).toContain(">两座城市</text>");
    expect(svg).toContain(">北方</text>");
    expect(svg).toContain(">南方</text>");
    expect(svg?.match(/class="r3-mmd-edge"/g)).toHaveLength(1);
  });

  test("retains quoted labels and both ends of bidirectional arrows", () => {
    const svg = renderMermaidSvg(
      "mermaid",
      `flowchart LR
        A <==>|"山间道路"| B
        B <-->|"返回路线"| C
      `,
    );
    expect(svg).toContain(">山间道路</text>");
    expect(svg).toContain(">返回路线</text>");
    expect(svg?.match(/marker-start=/g)).toHaveLength(2);
    expect(svg?.match(/marker-end=/g)).toHaveLength(2);
    expect(svg).toContain("r3-mmd-thick");
    expect(svg).toContain(">C</text>");
  });

  test("renders common label markup as multiline text without admitting HTML", () => {
    const svg = renderMermaidSvg(
      "mermaid",
      'flowchart TD\nA["<b>北城</b><br>平原<br/><i>南城</i><br /><script>alert(1)</script>"] --> B[终点]',
    );
    expect(svg).toContain(">北城</text>");
    expect(svg).toContain(">平原</text>");
    expect(svg).toContain(">南城</text>");
    expect(svg).not.toContain("&lt;b&gt;");
    expect(svg).not.toContain("&lt;br");
    expect(svg).not.toContain("&lt;i&gt;");
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });
});

describe("renderPublishedMarkdown mermaid fences", () => {
  test("wraps a flowchart fence in .r3-mermaid without source-line mappings", async () => {
    const html = await renderPublishedMarkdown("intro\n\n```mermaid\nflowchart LR\n  A-->B\n```\n");
    expect(html).toContain('class="r3-mermaid"');
    expect(html).not.toContain("data-line-start");
    expect(html).toContain("<svg");
    expect(html).toContain("A");
    expect(html).toContain("B");
    expect(html).not.toContain("language-mermaid");
  });

  test("falls through to a highlighted code fence for pie charts", async () => {
    const html = await renderPublishedMarkdown('```mermaid\npie title Pets\n  "dogs" : 10\n```\n');
    expect(html).not.toContain("r3-mermaid");
    expect(html).toContain("language-mermaid");
  });
});
