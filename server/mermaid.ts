// Mermaid fence → safe SVG (flowchart + sequenceDiagram). Mermaid.js is not used
// (DOM, label-XSS, size). Anything else returns null → ordinary code fence.
// Unrecognised statements are skipped rather than failing the whole diagram.

export const MAX_MERMAID_BYTES = 32 * 1024;
export const MAX_MERMAID_NODES = 120;

const FONT = 12;
const LINE_H = 15;
const PAD_X = 12;
const PAD_Y = 8;
const NODE_SEP = 16;
const RANK_SEP = 52;
const BAND_SEP = 24;
const MARGIN = 12;
const SG_PAD = 12;
const SG_TITLE = 16;
const MAX_LABEL_W = 180;
const SEQ_COL_MIN = 128;
const SEQ_ROW = 36;
const SEQ_HEAD = 34;

type Dir = "TB" | "BT" | "LR" | "RL";
type Stroke = "solid" | "dotted" | "thick" | "invisible";
type Shape =
  | "rect"
  | "round"
  | "stadium"
  | "subroutine"
  | "cylinder"
  | "circle"
  | "diamond"
  | "hexagon"
  | "asymmetric"
  | "parallelogram"
  | "trapezoid";

interface Node {
  id: string;
  label: string;
  shape: Shape;
  order: number;
}

interface Edge {
  from: string;
  to: string;
  label: string;
  stroke: Stroke;
  arrow: boolean;
  bidir: boolean;
}

interface Cluster {
  id: string;
  label: string;
  parent: string | null;
  nodes: Set<string>;
}

interface Flow {
  dir: Dir;
  nodes: Map<string, Node>;
  edges: Edge[];
  clusters: Cluster[];
}

let mermaidSeq = 0;
function nextUid(): string {
  mermaidSeq += 1;
  return `r3m${mermaidSeq}`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function decodeMermaidEntities(s: string): string {
  return s
    .replace(/#quot;/gi, '"')
    .replace(/#39;/g, "'")
    .replace(/#lt;/gi, "<")
    .replace(/#gt;/gi, ">")
    .replace(/#amp;/gi, "&")
    .replace(/#35;/g, "#")
    .replace(/#(\d+);/g, (_, n) => {
      const cp = Number(n);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : _;
    });
}

function measure(text: string, fontSize = FONT): number {
  let w = 0;
  for (const ch of text) w += ch.charCodeAt(0) > 127 ? fontSize : fontSize * 0.62;
  return w;
}

function wrapLabel(text: string, maxW = MAX_LABEL_W): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let cur = "";
  const pushHard = (word: string) => {
    let chunk = "";
    for (const ch of word) {
      const trial = chunk + ch;
      if (chunk && measure(trial) > maxW) {
        lines.push(chunk);
        chunk = ch;
      } else chunk = trial;
    }
    cur = chunk;
  };
  for (const word of words) {
    const trial = cur ? `${cur} ${word}` : word;
    if (measure(trial) <= maxW) cur = trial;
    else {
      if (cur) lines.push(cur);
      if (measure(word) > maxW) pushHard(word);
      else cur = word;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function nodeSize(label: string, shape: Shape): { w: number; h: number; lines: string[] } {
  const lines = wrapLabel(label);
  const textW = Math.max(...lines.map((l) => measure(l)), 12);
  let w = Math.min(MAX_LABEL_W + PAD_X * 2, textW + PAD_X * 2);
  let h = lines.length * LINE_H + PAD_Y * 2;
  if (shape === "diamond" || shape === "hexagon") {
    w += 18;
    h += 14;
  }
  if (shape === "circle") {
    const s = Math.max(w, h);
    w = s;
    h = s;
  }
  if (shape === "cylinder") h += 10;
  w = Math.max(w, 36);
  h = Math.max(h, 28);
  return { w, h, lines };
}

function stripNoise(src: string): string {
  let s = src
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  if (s.startsWith("---\n")) {
    const end = s.indexOf("\n---\n", 4);
    if (end !== -1) s = s.slice(end + 5);
  }
  s = s.replace(/%%\{[\s\S]*?\}%%/g, "");
  s = s.replace(/%%[^\n]*/g, "");
  return s;
}

export function isMermaidFence(info: string): boolean {
  const word =
    info
      .trim()
      .split(/[\s,{]/)[0]
      ?.toLowerCase() ?? "";
  return word === "mermaid" || word === "mmd";
}

// ---- flowchart parser ----------------------------------------------------

const SKIP_STMT = /^(classDef|class|style|click|linkStyle|interpolate)\b/i;

const SHAPES: [open: string, close: string, shape: Shape][] = [
  ["[[", "]]", "subroutine"],
  ["[/", "/]", "parallelogram"],
  ["[/", "\\]", "trapezoid"],
  ["[\\", "\\]", "trapezoid"],
  ["[\\", "/]", "parallelogram"],
  ["[(", ")]", "cylinder"],
  ["((", "))", "circle"],
  ["([", "])", "stadium"],
  ["{{", "}}", "hexagon"],
  [">", "]", "asymmetric"],
  ["{", "}", "diamond"],
  ["[", "]", "rect"],
  ["(", ")", "round"],
];

interface Arrow {
  stroke: Stroke;
  arrow: boolean;
  bidir: boolean;
  label: string;
  next: number;
}

function skipSpaces(s: string, i: number): number {
  while (i < s.length && (s[i] === " " || s[i] === "\t")) i++;
  return i;
}

function skipSep(s: string, i: number): number {
  while (i < s.length && /[\s;]/.test(s[i])) i++;
  return i;
}

function isIdentChar(c: string): boolean {
  return /[A-Za-z0-9_.-]/.test(c);
}

// A hyphen starts an arrow (`-->`, `-.->`, `---`), so an unquoted id must not
// swallow it — `A-->B` is two nodes, not one id named `A--`.
function isArrowStart(s: string, i: number): boolean {
  return (
    s.startsWith("-->", i) ||
    s.startsWith("---", i) ||
    s.startsWith("-.->", i) ||
    s.startsWith("-.", i) ||
    s.startsWith("==>", i) ||
    s.startsWith("===", i) ||
    s.startsWith("~~~", i) ||
    s.startsWith("<-->", i) ||
    s.startsWith("<==>", i)
  );
}

function readQuoted(s: string, i: number): { text: string; next: number } | null {
  const q = s[i];
  if (q !== '"' && q !== "'") return null;
  i++;
  let out = "";
  while (i < s.length && s[i] !== q && s[i] !== "\n") {
    if (s[i] === "\\" && i + 1 < s.length) {
      out += s[i + 1];
      i += 2;
      continue;
    }
    out += s[i];
    i++;
  }
  if (s[i] !== q) return null;
  return { text: decodeMermaidEntities(out), next: i + 1 };
}

function readIdent(s: string, i: number): { text: string; next: number } | null {
  if (i >= s.length) return null;
  const q = readQuoted(s, i);
  if (q) return q;
  if (!/[A-Za-z0-9_]/.test(s[i])) return null;
  let j = i + 1;
  while (j < s.length && isIdentChar(s[j])) {
    if (s[j] === "-" && isArrowStart(s, j)) break;
    j++;
  }
  return { text: s.slice(i, j), next: j };
}

function readUntil(s: string, i: number, close: string): { text: string; next: number } | null {
  const q = readQuoted(s, i);
  if (q) {
    const n = skipSpaces(s, q.next);
    if (!s.startsWith(close, n)) return null;
    return { text: q.text, next: n + close.length };
  }
  const end = s.indexOf(close, i);
  if (end === -1 || s.slice(i, end).includes("\n")) return null;
  return { text: decodeMermaidEntities(s.slice(i, end).trim()), next: end + close.length };
}

function readShape(s: string, i: number): { label: string; shape: Shape; next: number } | null {
  for (const [open, close, shape] of SHAPES) {
    if (!s.startsWith(open, i)) continue;
    const body = readUntil(s, i + open.length, close);
    if (!body) continue;
    return { label: body.text, shape, next: body.next };
  }
  return null;
}

function readArrow(s: string, i: number): Arrow | null {
  const start = skipSpaces(s, i);
  const rest = s.slice(start);
  const labeled: [RegExp, Stroke, boolean][] = [
    [/^-\.->\|([^|]*)\|/, "dotted", true],
    [/^-->\|([^|]*)\|/, "solid", true],
    [/^==>\|([^|]*)\|/, "thick", true],
    [/^---\|([^|]*)\|/, "solid", false],
    [/^===\|([^|]*)\|/, "thick", false],
    [/^-\.\s+(.+?)\s+\.->/, "dotted", true],
    [/^--\s+(.+?)\s+-->/, "solid", true],
    [/^==\s+(.+?)\s+==>/, "thick", true],
  ];
  for (const [re, stroke, arrow] of labeled) {
    const m = re.exec(rest);
    if (m) {
      return { stroke, arrow, bidir: false, label: m[1].trim(), next: start + m[0].length };
    }
  }
  const plain: [RegExp, Stroke, boolean, boolean][] = [
    [/^<-->/, "solid", true, true],
    [/^<==>/, "thick", true, true],
    [/^-.->/, "dotted", true, false],
    [/^-->/, "solid", true, false],
    [/^==>/, "thick", true, false],
    [/^---/, "solid", false, false],
    [/^===/, "thick", false, false],
    [/^~~~/, "invisible", false, false],
  ];
  for (const [re, stroke, arrow, bidir] of plain) {
    const m = re.exec(rest);
    if (m) return { stroke, arrow, bidir, label: "", next: start + m[0].length };
  }
  return null;
}

function parseFlowchart(src: string): Flow | null {
  const s = stripNoise(src);
  let i = skipSep(s, 0);
  const header = /^(flowchart(?:-elk)?|graph)\b/i.exec(s.slice(i));
  if (!header) return null;
  i += header[0].length;
  i = skipSpaces(s, i);
  let dir: Dir = "TB";
  const d = /^(TB|TD|BT|RL|LR)\b/i.exec(s.slice(i));
  if (d) {
    i += d[0].length;
    const u = d[0].toUpperCase();
    dir = u === "TD" ? "TB" : (u as Dir);
  }
  i = skipSep(s, i);

  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const clusters: Cluster[] = [];
  const stack: string[] = [];
  let order = 0;

  const currentCluster = (): string | null => stack[stack.length - 1] ?? null;

  const ensure = (id: string, label?: string, shape?: Shape): Node => {
    let n = nodes.get(id);
    if (!n) {
      n = { id, label: label ?? id, shape: shape ?? "rect", order: order++ };
      nodes.set(id, n);
      const cid = currentCluster();
      if (cid) clusters.find((c) => c.id === cid)?.nodes.add(id);
    } else {
      if (label != null && label !== id) n.label = label;
      if (shape) n.shape = shape;
    }
    return n;
  };

  const parseNode = (): Node | null => {
    i = skipSpaces(s, i);
    const idTok = readIdent(s, i);
    if (!idTok) return null;
    i = skipSpaces(s, idTok.next);
    const sh = readShape(s, i);
    if (sh) {
      i = sh.next;
      return ensure(idTok.text, sh.label || idTok.text, sh.shape);
    }
    i = idTok.next;
    return ensure(idTok.text);
  };

  const parseNodeList = (): Node[] | null => {
    const first = parseNode();
    if (!first) return null;
    const out = [first];
    for (;;) {
      const j = skipSpaces(s, i);
      if (s[j] !== "&") break;
      i = skipSpaces(s, j + 1);
      const n = parseNode();
      if (!n) break;
      out.push(n);
    }
    return out;
  };

  while (i < s.length) {
    i = skipSep(s, i);
    if (i >= s.length) break;

    if (SKIP_STMT.test(s.slice(i))) {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? s.length : nl + 1;
      continue;
    }

    if (/^direction\b/i.test(s.slice(i))) {
      i += 9;
      i = skipSpaces(s, i);
      const dd = /^(TB|TD|BT|RL|LR)\b/i.exec(s.slice(i));
      if (dd) {
        i += dd[0].length;
        if (stack.length === 0) {
          const u = dd[0].toUpperCase();
          dir = u === "TD" ? "TB" : (u as Dir);
        }
      }
      continue;
    }

    if (/^end\b/i.test(s.slice(i))) {
      const after = i + 3;
      if (after >= s.length || !isIdentChar(s[after])) {
        const peek = skipSpaces(s, after);
        if (s[peek] !== "[" && s[peek] !== "(" && s[peek] !== "{" && s[peek] !== ">") {
          i = after;
          stack.pop();
          continue;
        }
      }
    }

    if (/^subgraph\b/i.test(s.slice(i))) {
      i += 8;
      i = skipSpaces(s, i);
      let id = "";
      let label = "";
      const q = readQuoted(s, i);
      if (q) {
        id = q.text;
        label = q.text;
        i = q.next;
      } else {
        const idTok = readIdent(s, i);
        if (idTok) {
          id = idTok.text;
          label = idTok.text;
          i = idTok.next;
          i = skipSpaces(s, i);
          const sh = readShape(s, i);
          if (sh) {
            label = sh.label || label;
            i = sh.next;
          } else {
            const nl = s.indexOf("\n", i);
            const rest = s.slice(i, nl === -1 ? s.length : nl).trim();
            if (rest) {
              label = decodeMermaidEntities(rest);
              i = nl === -1 ? s.length : nl;
            }
          }
        }
      }
      if (!id) id = `sg${clusters.length}`;
      const parent = currentCluster();
      clusters.push({ id, label, parent, nodes: new Set() });
      stack.push(id);
      continue;
    }

    const save = i;
    const left = parseNodeList();
    if (!left) {
      const nl = s.indexOf("\n", save);
      i = nl === -1 ? s.length : nl + 1;
      continue;
    }
    let lhs = left;
    for (;;) {
      const arr = readArrow(s, i);
      if (!arr) break;
      i = arr.next;
      const right = parseNodeList();
      if (!right) break;
      for (const a of lhs) {
        for (const b of right) {
          edges.push({
            from: a.id,
            to: b.id,
            label: decodeMermaidEntities(arr.label),
            stroke: arr.stroke,
            arrow: arr.arrow,
            bidir: arr.bidir,
          });
        }
      }
      lhs = right;
    }
  }

  if (nodes.size === 0 || nodes.size > MAX_MERMAID_NODES) return null;
  if (edges.length > MAX_MERMAID_NODES * 4) return null;
  return { dir, nodes, edges, clusters };
}

function longestPathRanks(ids: string[], edges: Edge[]): Map<string, number> {
  const preds = new Map<string, string[]>();
  for (const id of ids) preds.set(id, []);
  for (const e of edges) {
    if (e.from === e.to || e.stroke === "invisible") continue;
    if (!preds.has(e.to) || !preds.has(e.from)) continue;
    preds.get(e.to)!.push(e.from);
  }
  const rank = new Map<string, number>();
  const state = new Map<string, 0 | 1 | 2>();
  const dfs = (n: string): number => {
    const st = state.get(n) ?? 0;
    if (st === 1) return rank.get(n) ?? 0;
    if (st === 2) return rank.get(n) ?? 0;
    state.set(n, 1);
    let r = 0;
    for (const p of preds.get(n) ?? []) r = Math.max(r, dfs(p) + 1);
    rank.set(n, r);
    state.set(n, 2);
    return r;
  };
  for (const id of ids) dfs(id);
  return rank;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
  node: Node;
}

function clusterDescendants(c: Cluster, clusters: Cluster[]): string[] {
  const ids = [...c.nodes];
  for (const ch of clusters) {
    if (ch.parent === c.id) ids.push(...clusterDescendants(ch, clusters));
  }
  return ids;
}

function layoutFlow(flow: Flow): {
  boxes: Map<string, Box>;
  clusters: { cluster: Cluster; x: number; y: number; w: number; h: number }[];
  width: number;
  height: number;
} {
  const ids = [...flow.nodes.keys()];
  const ranks = longestPathRanks(ids, flow.edges);
  const horiz = flow.dir === "LR" || flow.dir === "RL";
  const reverse = flow.dir === "RL" || flow.dir === "BT";

  const topClusters = flow.clusters.filter(
    (c) => c.parent == null && clusterDescendants(c, flow.clusters).length > 0,
  );
  const owned = new Set<string>();
  for (const c of flow.clusters) for (const n of c.nodes) owned.add(n);

  const bands: { key: string; cluster: Cluster | null; ids: string[] }[] = [];
  const free = ids.filter((id) => !owned.has(id));
  if (free.length) bands.push({ key: "", cluster: null, ids: free });
  for (const c of topClusters) {
    bands.push({ key: c.id, cluster: c, ids: clusterDescendants(c, flow.clusters) });
  }
  if (bands.length === 0) bands.push({ key: "", cluster: null, ids });

  const sizes = new Map<string, { w: number; h: number; lines: string[] }>();
  for (const n of flow.nodes.values()) sizes.set(n.id, nodeSize(n.label, n.shape));

  let maxRank = 0;
  for (const r of ranks.values()) maxRank = Math.max(maxRank, r);
  if (reverse) {
    for (const id of ids) ranks.set(id, maxRank - (ranks.get(id) ?? 0));
  }

  const rankW: number[] = Array.from({ length: maxRank + 1 }, () => 0);
  const rankH: number[] = Array.from({ length: maxRank + 1 }, () => 0);
  for (const id of ids) {
    const r = ranks.get(id) ?? 0;
    const sz = sizes.get(id)!;
    if (horiz) {
      rankW[r] = Math.max(rankW[r], sz.w);
      rankH[r] = Math.max(rankH[r], sz.h);
    } else {
      rankH[r] = Math.max(rankH[r], sz.h);
      rankW[r] = Math.max(rankW[r], sz.w);
    }
  }

  const hasClusters = topClusters.length > 0;
  const origin = MARGIN + (hasClusters ? SG_PAD : 0);
  const rankPos: number[] = [];
  let acc = origin;
  for (let r = 0; r <= maxRank; r++) {
    rankPos[r] = acc;
    acc += (horiz ? rankW[r] : rankH[r]) + RANK_SEP;
  }

  const stackH = (bandIds: string[], r: number): number => {
    const ns = bandIds
      .filter((id) => (ranks.get(id) ?? 0) === r)
      .sort((a, b) => flow.nodes.get(a)!.order - flow.nodes.get(b)!.order);
    if (ns.length === 0) return 0;
    let h = 0;
    for (const id of ns) h += (horiz ? sizes.get(id)!.h : sizes.get(id)!.w) + NODE_SEP;
    return h - NODE_SEP;
  };

  const bandHeight: number[] = bands.map((b) => {
    let m = 0;
    for (let r = 0; r <= maxRank; r++) m = Math.max(m, stackH(b.ids, r));
    return Math.max(m, 28);
  });

  const bandY: number[] = [];
  let yAcc = MARGIN;
  for (let b = 0; b < bands.length; b++) {
    const header = bands[b].cluster ? SG_TITLE + SG_PAD : 0;
    bandY[b] = yAcc + header;
    yAcc += header + bandHeight[b] + (bands[b].cluster ? SG_PAD : 0) + BAND_SEP;
  }

  const boxes = new Map<string, Box>();
  for (let b = 0; b < bands.length; b++) {
    const band = bands[b];
    for (let r = 0; r <= maxRank; r++) {
      const ns = band.ids
        .filter((id) => (ranks.get(id) ?? 0) === r)
        .sort((a, c) => flow.nodes.get(a)!.order - flow.nodes.get(c)!.order);
      const sh = stackH(band.ids, r);
      let off = bandY[b] + (bandHeight[b] - sh) / 2;
      for (const id of ns) {
        const sz = sizes.get(id)!;
        const node = flow.nodes.get(id)!;
        if (horiz) {
          boxes.set(id, {
            x: Math.round(rankPos[r] + (rankW[r] - sz.w) / 2),
            y: Math.round(off),
            w: Math.round(sz.w),
            h: Math.round(sz.h),
            lines: sz.lines,
            node,
          });
          off += sz.h + NODE_SEP;
        } else {
          boxes.set(id, {
            x: Math.round(off),
            y: Math.round(rankPos[r] + (rankH[r] - sz.h) / 2),
            w: Math.round(sz.w),
            h: Math.round(sz.h),
            lines: sz.lines,
            node,
          });
          off += sz.w + NODE_SEP;
        }
      }
    }
  }

  const clusterBoxes: { cluster: Cluster; x: number; y: number; w: number; h: number }[] = [];
  for (const c of flow.clusters) {
    const memberIds = clusterDescendants(c, flow.clusters);
    if (memberIds.length === 0) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const id of memberIds) {
      const box = boxes.get(id);
      if (!box) continue;
      minX = Math.min(minX, box.x);
      minY = Math.min(minY, box.y);
      maxX = Math.max(maxX, box.x + box.w);
      maxY = Math.max(maxY, box.y + box.h);
    }
    if (!Number.isFinite(minX)) continue;
    clusterBoxes.push({
      cluster: c,
      x: Math.round(minX - SG_PAD),
      y: Math.round(minY - SG_PAD - SG_TITLE),
      w: Math.round(maxX - minX + SG_PAD * 2),
      h: Math.round(maxY - minY + SG_PAD * 2 + SG_TITLE),
    });
  }

  let width = 0;
  let height = 0;
  for (const box of boxes.values()) {
    width = Math.max(width, box.x + box.w);
    height = Math.max(height, box.y + box.h);
  }
  for (const c of clusterBoxes) {
    width = Math.max(width, c.x + c.w);
    height = Math.max(height, c.y + c.h);
  }
  return { boxes, clusters: clusterBoxes, width: width + MARGIN, height: height + MARGIN };
}

function port(box: Box, side: "left" | "right" | "top" | "bottom"): { x: number; y: number } {
  switch (side) {
    case "left":
      return { x: box.x, y: box.y + box.h / 2 };
    case "right":
      return { x: box.x + box.w, y: box.y + box.h / 2 };
    case "top":
      return { x: box.x + box.w / 2, y: box.y };
    case "bottom":
      return { x: box.x + box.w / 2, y: box.y + box.h };
  }
}

function cubicMid(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  p3: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: 0.125 * p0.x + 0.375 * p1.x + 0.375 * p2.x + 0.125 * p3.x,
    y: 0.125 * p0.y + 0.375 * p1.y + 0.375 * p2.y + 0.125 * p3.y,
  };
}

function shapeSvg(box: Box): string {
  const { x, y, w, h, node } = box;
  const cls = 'class="r3-mmd-node"';
  switch (node.shape) {
    case "round":
    case "stadium":
      return `<rect ${cls} x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" ry="${h / 2}"/>`;
    case "circle":
      return `<ellipse ${cls} cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}"/>`;
    case "diamond": {
      const cx = x + w / 2;
      const cy = y + h / 2;
      return `<polygon ${cls} points="${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}"/>`;
    }
    case "hexagon": {
      const inset = Math.min(16, w * 0.18);
      return `<polygon ${cls} points="${x + inset},${y} ${x + w - inset},${y} ${x + w},${y + h / 2} ${x + w - inset},${y + h} ${x + inset},${y + h} ${x},${y + h / 2}"/>`;
    }
    case "parallelogram": {
      const skew = Math.min(14, w * 0.15);
      return `<polygon ${cls} points="${x + skew},${y} ${x + w},${y} ${x + w - skew},${y + h} ${x},${y + h}"/>`;
    }
    case "trapezoid": {
      const inset = Math.min(14, w * 0.15);
      return `<polygon ${cls} points="${x + inset},${y} ${x + w - inset},${y} ${x + w},${y + h} ${x},${y + h}"/>`;
    }
    case "asymmetric":
      return `<polygon ${cls} points="${x},${y} ${x + w - 10},${y} ${x + w},${y + h / 2} ${x + w - 10},${y + h} ${x},${y + h}"/>`;
    case "subroutine":
      return (
        `<rect ${cls} x="${x}" y="${y}" width="${w}" height="${h}" rx="4"/>` +
        `<path class="r3-mmd-node" fill="none" d="M ${x + 6} ${y} V ${y + h} M ${x + w - 6} ${y} V ${y + h}"/>`
      );
    case "cylinder": {
      const ry = Math.min(8, h * 0.18);
      return (
        `<path ${cls} d="M ${x} ${y + ry} A ${w / 2} ${ry} 0 0 1 ${x + w} ${y + ry} V ${y + h - ry} A ${w / 2} ${ry} 0 0 1 ${x} ${y + h - ry} Z"/>` +
        `<path class="r3-mmd-node" fill="none" d="M ${x} ${y + ry} A ${w / 2} ${ry} 0 0 0 ${x + w} ${y + ry}"/>`
      );
    }
    default:
      return `<rect ${cls} x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>`;
  }
}

function renderFlow(flow: Flow): string {
  const uid = nextUid();
  const { boxes, clusters, width, height } = layoutFlow(flow);
  const horiz = flow.dir === "LR" || flow.dir === "RL";
  const parts: string[] = [];
  parts.push(
    `<defs><marker id="${uid}-a" viewBox="0 0 10 8" refX="9" refY="4" markerWidth="8" markerHeight="7" orient="auto">` +
      `<path class="r3-mmd-arrow" d="M0 0 L10 4 L0 8 z"/></marker>` +
      `<marker id="${uid}-s" viewBox="0 0 10 8" refX="1" refY="4" markerWidth="8" markerHeight="7" orient="auto">` +
      `<path class="r3-mmd-arrow" d="M10 0 L0 4 L10 8 z"/></marker></defs>`,
  );

  for (const c of clusters) {
    parts.push(
      `<rect class="r3-mmd-cluster" x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="8"/>`,
    );
    parts.push(
      `<text class="r3-mmd-cluster-title" x="${c.x + SG_PAD}" y="${c.y + 13}">${esc(c.cluster.label)}</text>`,
    );
  }

  for (const e of flow.edges) {
    if (e.stroke === "invisible") continue;
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (!a || !b) continue;
    let p0: { x: number; y: number };
    let p3: { x: number; y: number };
    if (horiz) {
      if (b.x >= a.x + a.w * 0.5) {
        p0 = port(a, "right");
        p3 = port(b, "left");
      } else {
        p0 = port(a, "left");
        p3 = port(b, "right");
      }
    } else if (b.y >= a.y + a.h * 0.5) {
      p0 = port(a, "bottom");
      p3 = port(b, "top");
    } else {
      p0 = port(a, "top");
      p3 = port(b, "bottom");
    }
    const dx = horiz ? Math.max(28, Math.abs(p3.x - p0.x) * 0.45) : 0;
    const dy = horiz ? 0 : Math.max(28, Math.abs(p3.y - p0.y) * 0.45);
    const signX = p3.x >= p0.x ? 1 : -1;
    const signY = p3.y >= p0.y ? 1 : -1;
    const p1 = { x: p0.x + signX * dx, y: p0.y + signY * dy };
    const p2 = { x: p3.x - signX * dx, y: p3.y - signY * dy };
    const d = `M ${p0.x} ${p0.y} C ${p1.x} ${p1.y}, ${p2.x} ${p2.y}, ${p3.x} ${p3.y}`;
    const cls = ["r3-mmd-edge"];
    if (e.stroke === "dotted") cls.push("r3-mmd-dotted");
    if (e.stroke === "thick") cls.push("r3-mmd-thick");
    const end = e.arrow ? ` marker-end="url(#${uid}-a)"` : "";
    const start = e.bidir ? ` marker-start="url(#${uid}-s)"` : "";
    parts.push(`<path class="${cls.join(" ")}" d="${d}"${end}${start}/>`);
    if (e.label) {
      const mid = cubicMid(p0, p1, p2, p3);
      const tw = measure(e.label, 11) + 8;
      const th = 14;
      parts.push(
        `<rect class="r3-mmd-edgelabel-bg" x="${mid.x - tw / 2}" y="${mid.y - th / 2}" width="${tw}" height="${th}" rx="3"/>`,
        `<text class="r3-mmd-edgelabel" x="${mid.x}" y="${mid.y}" text-anchor="middle" dominant-baseline="middle">${esc(e.label)}</text>`,
      );
    }
  }

  for (const box of boxes.values()) {
    parts.push(shapeSvg(box));
    const cx = box.x + box.w / 2;
    const total = box.lines.length * LINE_H;
    const y0 = box.y + box.h / 2 - total / 2 + LINE_H / 2;
    box.lines.forEach((line, li) => {
      parts.push(
        `<text class="r3-mmd-label" x="${cx}" y="${y0 + li * LINE_H}" text-anchor="middle" dominant-baseline="middle">${esc(line)}</text>`,
      );
    });
  }

  return wrapSvg(parts.join(""), width, height, "flowchart");
}

// ---- sequence diagram ----------------------------------------------------

interface SeqActor {
  id: string;
  label: string;
}

interface SeqMsg {
  from: string;
  to: string;
  text: string;
  dashed: boolean;
}

interface SeqBox {
  label: string;
  start: number;
  end: number;
}

interface Sequence {
  actors: SeqActor[];
  messages: SeqMsg[];
  boxes: SeqBox[];
}

function parseSequence(src: string): Sequence | null {
  const s = stripNoise(src);
  const lines = s.split("\n");
  if (!/^\s*sequenceDiagram\b/i.test(lines[0] ?? "")) return null;
  const actors: SeqActor[] = [];
  const index = new Map<string, number>();
  const messages: SeqMsg[] = [];
  const boxes: SeqBox[] = [];
  const boxStack: SeqBox[] = [];

  const ensureActor = (id: string, label?: string) => {
    if (!index.has(id)) {
      index.set(id, actors.length);
      actors.push({ id, label: label ?? id });
    } else if (label) {
      actors[index.get(id)!].label = label;
    }
  };

  // Actor ids stop at the arrow: a greedy `\S+` would swallow the extra dash
  // of `-->>` and mint a bogus `S-` participant.
  const ARROW = /^(\S+?)\s*(-->>|->>|-->|->|--\)|-\))\s*(\S+)\s*:\s*(.*)$/;

  for (let li = 1; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw.trim();
    if (!line) continue;
    if (/^autonumber\b/i.test(line)) continue;
    const part = /^(?:participant|actor)\s+(\S+)(?:\s+as\s+(.*))?$/i.exec(line);
    if (part) {
      ensureActor(part[1], part[2]?.trim() || part[1]);
      continue;
    }
    if (/^(?:activate|deactivate|title)\b/i.test(line)) continue;
    const boxOpen = /^(loop|alt|opt|par|critical|break|rect|box)\b\s*(.*)$/i.exec(line);
    if (boxOpen) {
      const box: SeqBox = {
        label: boxOpen[2].trim() || boxOpen[1],
        start: messages.length,
        end: -1,
      };
      boxStack.push(box);
      continue;
    }
    if (/^(?:else|and|option)\b/i.test(line)) continue;
    if (/^end\b/i.test(line)) {
      const box = boxStack.pop();
      if (box) {
        box.end = Math.max(messages.length - 1, box.start);
        if (box.end >= box.start) boxes.push(box);
      }
      continue;
    }
    const note = /^Note\s+(?:left of|right of|over)\s+\S+(?:\s*,\s*\S+)?\s*:\s*(.*)$/i.exec(line);
    if (note) {
      // Notes ride as a message-row so the following arrows keep their spacing.
      const last = actors[actors.length - 1];
      if (last) messages.push({ from: last.id, to: last.id, text: note[1], dashed: true });
      continue;
    }
    const m = ARROW.exec(line);
    if (!m) continue;
    ensureActor(m[1]);
    ensureActor(m[3]);
    const dashed = m[2].startsWith("--") || m[2] === "-)";
    messages.push({ from: m[1], to: m[3], text: m[4].trim(), dashed });
  }
  for (const box of boxStack) {
    box.end = Math.max(messages.length - 1, box.start);
    if (box.end >= box.start) boxes.push(box);
  }
  if (actors.length === 0) return null;
  if (actors.length + messages.length > MAX_MERMAID_NODES * 2) return null;
  return { actors, messages, boxes };
}

function renderSequence(seq: Sequence): string {
  const uid = nextUid();
  const colW = Math.ceil(
    Math.max(SEQ_COL_MIN, ...seq.actors.map((a) => measure(a.label) + PAD_X * 2 + 16)),
  );
  const width = MARGIN * 2 + seq.actors.length * colW;
  const height = MARGIN * 2 + SEQ_HEAD + Math.max(seq.messages.length, 1) * SEQ_ROW + 16;
  const cx = (i: number) => Math.round(MARGIN + i * colW + colW / 2);
  const idx = new Map(seq.actors.map((a, i) => [a.id, i]));
  const yMsg = (row: number) => Math.round(MARGIN + SEQ_HEAD + 22 + row * SEQ_ROW);
  const parts: string[] = [];
  parts.push(
    `<defs><marker id="${uid}-a" viewBox="0 0 10 8" refX="9" refY="4" markerWidth="8" markerHeight="7" orient="auto">` +
      `<path class="r3-mmd-arrow" d="M0 0 L10 4 L0 8 z"/></marker></defs>`,
  );

  const lifeTop = MARGIN + SEQ_HEAD;
  const lifeBot = height - MARGIN;
  for (let i = 0; i < seq.actors.length; i++) {
    parts.push(
      `<line class="r3-mmd-life" x1="${cx(i)}" y1="${lifeTop}" x2="${cx(i)}" y2="${lifeBot}"/>`,
    );
  }

  for (const box of seq.boxes) {
    const from = yMsg(box.start) - 16;
    const to = yMsg(box.end) + 14;
    parts.push(
      `<rect class="r3-mmd-cluster" x="${MARGIN}" y="${from}" width="${width - MARGIN * 2}" height="${Math.max(to - from, 24)}" rx="6"/>`,
      `<text class="r3-mmd-cluster-title" x="${MARGIN + 8}" y="${from + 12}">${esc(box.label)}</text>`,
    );
  }

  for (let i = 0; i < seq.actors.length; i++) {
    const a = seq.actors[i];
    const w = Math.min(colW - 12, measure(a.label) + PAD_X * 2);
    const x = cx(i) - w / 2;
    const y = MARGIN;
    parts.push(
      `<rect class="r3-mmd-node" x="${x}" y="${y}" width="${w}" height="${SEQ_HEAD - 6}" rx="6"/>`,
      `<text class="r3-mmd-label" x="${cx(i)}" y="${y + (SEQ_HEAD - 6) / 2}" text-anchor="middle" dominant-baseline="middle">${esc(a.label)}</text>`,
    );
  }

  for (let row = 0; row < seq.messages.length; row++) {
    const m = seq.messages[row];
    const i = idx.get(m.from);
    const j = idx.get(m.to);
    if (i == null || j == null) continue;
    const y = yMsg(row);
    const x1 = cx(i);
    const x2 = cx(j);
    const cls = m.dashed ? "r3-mmd-edge r3-mmd-dotted" : "r3-mmd-edge";
    if (i === j) {
      parts.push(
        `<path class="${cls}" d="M ${x1} ${y} C ${x1 + 36} ${y}, ${x1 + 36} ${y + 16}, ${x1} ${y + 16}" marker-end="url(#${uid}-a)"/>`,
      );
    } else {
      const dir = x2 > x1 ? 1 : -1;
      parts.push(
        `<line class="${cls}" x1="${x1 + dir * 4}" y1="${y}" x2="${x2 - dir * 8}" y2="${y}" marker-end="url(#${uid}-a)"/>`,
      );
    }
    if (m.text) {
      const mx = (x1 + x2) / 2;
      const label = wrapLabel(m.text, Math.max(80, Math.abs(x2 - x1) - 16)).join(" ");
      parts.push(
        `<text class="r3-mmd-edgelabel" x="${mx}" y="${y - 8}" text-anchor="middle">${esc(label)}</text>`,
      );
    }
  }

  return wrapSvg(parts.join(""), width, height, "sequence diagram");
}

function wrapSvg(inner: string, width: number, height: number, kind: string): string {
  const w = Math.max(Math.ceil(width), 40);
  const h = Math.max(Math.ceil(height), 40);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" ` +
    `role="img" aria-label="${esc(kind)}">${inner}</svg>`
  );
}

/** SVG markup (no wrapper) or null when this fence isn't a diagram we render. */
export function renderMermaidSvg(info: string, source: string): string | null {
  if (!isMermaidFence(info)) return null;
  if (source.length > MAX_MERMAID_BYTES) return null;
  try {
    const trimmed = source.trim();
    if (!trimmed) return null;
    const kind = stripNoise(trimmed).trimStart();
    if (/^(flowchart(?:-elk)?|graph)\b/i.test(kind)) {
      const flow = parseFlowchart(trimmed);
      return flow ? renderFlow(flow) : null;
    }
    if (/^sequenceDiagram\b/i.test(kind)) {
      const seq = parseSequence(trimmed);
      return seq ? renderSequence(seq) : null;
    }
    return null;
  } catch {
    return null;
  }
}
