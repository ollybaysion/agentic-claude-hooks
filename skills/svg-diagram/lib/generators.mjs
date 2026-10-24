// 생성기 넷 — 스펙(구조만) → SVG 조각. 좌표는 전부 여기서 글꼴 크기(T)로 계산한다.
// SVG 안에는 좌표와 class 만 있다. 색 · 선 · 글꼴은 CSS 토큰(lib/styles.mjs)이 정한다.
//
// 새 그림 종류가 필요하면 여기에 생성기를 하나 더 쓴다. 규칙:
//   1. 스펙에는 구조만(칸 번호 · 순서 · 연결). 좌표 · 폭 · 높이는 받지 않는다.
//   2. 치수는 T(fs · fsTitle · fsV · fsK · fsLabel · fsTag)에서 계산하고, 글자 폭은 tw() 로 잰다.
//   3. 노드는 <g class="n" transform="translate(x y)"> 안에서 (0,0) 기준으로 그린다.
//   4. 선은 edgeEl() 로, 라벨은 layers() 로 노드 위에 맨 나중에 올린다.
//   5. GENERATORS 에 등록하고 specs/ 에 예시 스펙을 하나 둔다.

let T; // 지금 그리는 스타일의 생성기 인자(글꼴 크기 · 폭 계수 · 모서리 · 화살촉 …)

export const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const f = (v) =>
  Number.isInteger(v) ? String(v) : (Math.round(v * 10) / 10).toString();
const R = Math.round;

// 글자 폭 추정 — 스타일마다 계수(textW · monoW). 넉넉하게 잡는다. 굵은 글자는 6% 더.
export function tw(s, size, mono = false, bold = false) {
  const k = mono
    ? (T.monoW ?? { ascii: 0.62, cjk: 1.1 })
    : (T.textW ?? { ascii: 0.62, cjk: 1.02 });
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    w += (c > 0x2e80 ? k.cjk : c < 0x80 ? k.ascii : 0.85) * size;
  }
  return w * (bold ? 1.06 : 1);
}
function defs(p) {
  const open = T.marker === "open",
    d = open ? "M1.5,1.5 L8.5,5 L1.5,8.5" : "M0,0 L10,5 L0,10 z",
    sz = T.markerSize ?? (open ? 9 : 7);
  const ms = ["", "-b", "-a"]
    .map(
      (k) =>
        `<marker id="${p}-arr${k}" viewBox="0 0 10 10" refX="${open ? 8.5 : 9}" refY="5" markerWidth="${sz}" markerHeight="${sz}" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path class="arr${k}" d="${d}"/></marker>`,
    )
    .join("");
  const grid =
    T.grid === "lines"
      ? `<pattern id="${p}-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path class="grid" d="M20 0H0V20"/></pattern>`
      : T.grid === "dots"
        ? `<pattern id="${p}-grid" width="16" height="16" patternUnits="userSpaceOnUse"><circle class="grid" cx="1.5" cy="1.5" r="1"/></pattern>`
        : "";
  return ms + grid;
}
const svgWrap = (p, w, h, label, body) =>
  `<svg class="d s-${T.key}" width="${f(w)}" viewBox="0 0 ${f(w)} ${f(h)}" role="img" aria-label="${esc(label)}"><defs>${defs(p)}</defs>${T.grid ? `<rect class="gridbg" width="${f(w)}" height="${f(h)}" fill="url(#${p}-grid)"/>` : ""}${body}</svg>`;
const pathD = (pts) =>
  pts.map((q, i) => `${i ? "L" : "M"}${f(q[0])} ${f(q[1])}`).join(" ");
const markerFor = (p, cls) =>
  cls.includes("back")
    ? `${p}-arr-b`
    : cls.includes("accent")
      ? `${p}-arr-a`
      : `${p}-arr`;
// 가장 긴 구간의 t 지점(기본 가운데)에 라벨
function label(pts, text, opt = {}) {
  if (!text) return "";
  let best = 0,
    bi = 0;
  for (let i = 1; i < pts.length; i++) {
    const L =
      Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
    if (L > best) {
      best = L;
      bi = i;
    }
  }
  const [a, b] = [pts[bi - 1], pts[bi]];
  const t = opt.t ?? 0.5,
    mx = a[0] + (b[0] - a[0]) * t,
    my = a[1] + (b[1] - a[1]) * t,
    fL = T.fsLabel;
  if (a[1] === b[1])
    return `<text class="t-label" x="${f(mx)}" y="${f(my - fL * 0.45)}" text-anchor="middle">${esc(text)}</text>`;
  return (opt.side ?? "e") === "w"
    ? `<text class="t-label" x="${f(mx - 6)}" y="${f(my + fL * 0.35)}" text-anchor="end">${esc(text)}</text>`
    : `<text class="t-label" x="${f(mx + 6)}" y="${f(my + fL * 0.35)}">${esc(text)}</text>`;
}
// [선, 라벨] — 라벨은 노드 위에 맨 나중에 그린다
const edgeEl = (p, pts, cls, text, opt) => [
  `<path class="edge ${cls}" d="${pathD(pts)}" marker-end="url(#${markerFor(p, cls)})"${opt?.both ? ` marker-start="url(#${markerFor(p, cls)})"` : ""}/>`,
  label(pts, text, opt),
];
const layers = (es, nodes) =>
  es.map((e) => e[0]).join("") + nodes + es.map((e) => e[1]).join("");
const titleCls = (kind) =>
  T.titleBar ? "on-bar" : kind === "lead" ? "on-lead" : "";
const bar = (w, h, kind) =>
  T.titleBar
    ? `<rect class="bar ${kind ?? ""}" width="${f(w)}" height="${f(h)}" rx="${T.rx}"/>`
    : "";

// ── 생성기 1: 상자 흐름 그래프(boxflow) ────────────────────────────────
// 스펙: nodes[{id, col, row, kind?, title, rows?[[k, v]]}], edges[{from, to, label?, kind?('back' | 'cond' | 'accent' …), side?('w' | 'e')}]
// 상자 폭은 가장 긴 줄에서, 높이는 줄 수에서. 되돌아가는 선(back)은 왼쪽(기본) · 오른쪽(side: 'e') 통로로.
function boxflow(p, spec) {
  const { fsTitle: fT, fsV: fV, fsK: fK, fsLabel: fL } = T;
  const ROW_H = R(fV * 1.5),
    TITLE_H = R(fT * 2.1),
    PAD_X = R(fV * 0.9),
    PAD_B = R(fV * 0.7),
    KV = R(fK * 1.2);
  const GY = R(fV * 3.6),
    M = 20;
  const backs = spec.edges.filter((e) => (e.kind ?? "").includes("back"));
  // 열 사이는 같은 행을 잇는 선의 라벨이 들어가는 폭
  const rowOf = Object.fromEntries(spec.nodes.map((n) => [n.id, n.row]));
  const GX = Math.max(
    R(fL * 4.5),
    ...spec.edges
      .filter(
        (e) =>
          e.label &&
          !(e.kind ?? "").includes("back") &&
          rowOf[e.from] === rowOf[e.to],
      )
      .map((e) => Math.ceil(tw(e.label, fL) + 24)),
  );
  const west = backs.filter((e) => (e.side ?? "w") === "w"),
    east = backs.filter((e) => e.side === "e");
  const chan = west.length
    ? Math.ceil(Math.max(70, ...west.map((e) => tw(e.label ?? "", fL) + 44)))
    : 0;
  const chanE = east.length ? 28 + east.length * 12 + 10 : 0;
  const nodes = spec.nodes.map((n) => {
    const rows = n.rows ?? [];
    if (n.kind === "exit")
      return {
        ...n,
        rows,
        w: R(tw(n.title, fK, true) + fK * 2.2),
        h: R(fK * 2.4),
        kw: 0,
      };
    const kw = rows.length
      ? Math.ceil(Math.max(...rows.map(([k]) => tw(k, fK, true))) + KV)
      : 0;
    const need = Math.max(
      tw(n.title, fT, false, true) + fT,
      ...rows.map(([, v]) => kw + tw(v, fV)),
    );
    return {
      ...n,
      rows,
      kw,
      need: Math.ceil(need + 2 * PAD_X),
      h: TITLE_H + rows.length * ROW_H + (rows.length ? PAD_B : R(fT * 0.3)),
    };
  });
  const W = Math.max(
    spec.minWidth ?? 200,
    ...nodes.filter((n) => n.kind !== "exit").map((n) => n.need),
  );
  nodes.forEach((n) => {
    if (n.kind !== "exit") n.w = W;
  });
  const rowH = [];
  nodes.forEach((n) => {
    rowH[n.row] = Math.max(rowH[n.row] ?? 0, n.h);
  });
  const rowY = [];
  let y = M;
  rowH.forEach((h, r) => {
    rowY[r] = y;
    y += h + GY;
  });
  const H = y - GY + M,
    cols = Math.max(...nodes.map((n) => n.col)) + 1;
  const colX = (c) => M + chan + c * (W + GX);
  const Wt = M * 2 + chan + cols * W + (cols - 1) * GX + chanE;
  const by = {};
  // 같은 행의 노드는 세로 가운데를 맞춘다 — 가로 선이 수평이 된다
  nodes.forEach((n) => {
    n.x = colX(n.col) + (W - n.w) / 2;
    n.y = rowY[n.row] + (rowH[n.row] - n.h) / 2;
    n.cx = n.x + n.w / 2;
    n.cy = n.y + n.h / 2;
    by[n.id] = n;
  });
  const node = (n) => {
    if (n.kind === "exit")
      return `<g class="n" transform="translate(${f(n.x)} ${f(n.y)})"><rect class="exit" width="${n.w}" height="${n.h}" rx="${T.rxPill}"/><text class="t-k" x="${n.w / 2}" y="${f(n.h * 0.68)}" text-anchor="middle">${esc(n.title)}</text></g>`;
    const rows = n.rows
      .map(([k, v], i) => {
        const yy = TITLE_H + ROW_H * (i + 1) - R(ROW_H * 0.32);
        return `<text class="t-k" x="${PAD_X}" y="${yy}">${esc(k)}</text><text class="t-v" x="${PAD_X + n.kw}" y="${yy}">${esc(v)}</text>`;
      })
      .join("");
    const sep =
      n.rows.length && !T.titleBar
        ? `<line class="sep" x1="${PAD_X}" y1="${TITLE_H}" x2="${n.w - PAD_X}" y2="${TITLE_H}"/>`
        : "";
    return `<g class="n" transform="translate(${f(n.x)} ${f(n.y)})"><rect class="${n.kind ?? "box"}" width="${n.w}" height="${f(n.h)}" rx="${T.rx}"/>${bar(n.w, TITLE_H, n.kind)}<text class="t-title ${titleCls(n.kind)}" x="${n.w / 2}" y="${R(TITLE_H * 0.66)}" text-anchor="middle">${esc(n.title)}</text>${sep}${rows}</g>`;
  };
  let bk = 0;
  const edge = (e) => {
    const A = by[e.from],
      B = by[e.to],
      cls = e.kind ?? "";
    let pts,
      opt = {};
    if (cls.includes("back")) {
      const side = e.side ?? "w";
      if (side === "w") {
        const x = M + chan - 28 - bk++ * 12;
        pts = [
          [A.x, A.cy],
          [x, A.cy],
          [x, B.cy],
          [B.x, B.cy],
        ];
        opt.side = "w";
      } else {
        const x = A.x + A.w + 28 + bk++ * 12;
        pts = [
          [A.x + A.w, A.cy],
          [x, A.cy],
          [x, B.cy],
          [B.x + B.w, B.cy],
        ];
      }
    } else if (B.col === A.col)
      pts = [
        [A.cx, A.y + A.h],
        [B.cx, B.y],
      ];
    else if (B.row === A.row)
      pts =
        B.col > A.col
          ? [
              [A.x + A.w, A.cy],
              [B.x, B.cy],
            ]
          : [
              [A.x, A.cy],
              [B.x + B.w, B.cy],
            ];
    else if (B.row > A.row)
      pts = [
        [B.col > A.col ? A.x + A.w : A.x, A.cy],
        [B.cx, A.cy],
        [B.cx, B.y],
      ];
    else
      pts = [
        [A.cx, A.y],
        [A.cx, B.cy],
        [B.col < A.col ? B.x + B.w : B.x, B.cy],
      ];
    return edgeEl(p, pts, cls, e.label, opt);
  };
  return svgWrap(
    p,
    Wt,
    H,
    spec.caption,
    layers(spec.edges.map(edge), nodes.map(node).join("")),
  );
}

// ── 생성기 2: 격자 지도(gridmap) ───────────────────────────────────────
// 스펙: boxes[{id, col, row, kind?, title, lines?[]}], frames[{cols:[a,b], rows:[a,b], title}], edges[{from, to, label?, kind?('both' | 'accent' …), out?, in?('n' | 'e' | 's' | 'w')}]
// 칸 폭은 가장 긴 글에서, 칸 사이는 가장 긴 선 라벨에서. 한 변에 선이 여럿 붙으면 고르게 편다.
function gridmap(p, spec) {
  const { fsTitle: fT, fsV: fV, fsLabel: fL } = T;
  const LINE = R(fV * 1.4),
    TITLE = R(fT * 1.7),
    PAD = R(fV * 0.9),
    M = 22,
    FP = R(fV),
    FT = R(fT * 1.5);
  const frames = spec.frames ?? [];
  const boxes = spec.boxes.map((b) => ({ ...b, lines: b.lines ?? [] }));
  const CW = Math.max(
    spec.cellW ?? 110,
    ...boxes.map((b) =>
      Math.ceil(
        Math.max(
          tw(b.title, fT, false, true),
          ...b.lines.map((s) => tw(s, fV)),
        ) +
          2 * PAD,
      ),
    ),
  );
  const GX = Math.max(
      44,
      ...spec.edges
        .filter((e) => e.label)
        .map((e) => Math.ceil(tw(e.label, fL) + 16)),
    ),
    GY = R(fV * 2.8);
  boxes.forEach((b) => {
    b.w = CW;
    b.h = TITLE + b.lines.length * LINE + R(fV * 0.5);
  });
  const rowH = [];
  boxes.forEach((b) => {
    rowH[b.row] = Math.max(rowH[b.row] ?? 0, b.h);
  });
  const depth = (r) =>
    frames.filter(
      (g) =>
        g !== r &&
        g.cols[0] <= r.cols[0] &&
        g.cols[1] >= r.cols[1] &&
        g.rows[0] <= r.rows[0] &&
        g.rows[1] >= r.rows[1],
    ).length;
  const maxD = Math.max(0, ...frames.map(depth)) + (frames.length ? 1 : 0);
  const x0 = M + FP * maxD,
    y0 = M + (FT + FP) * maxD;
  const rowY = [];
  let y = y0;
  rowH.forEach((h, r) => {
    rowY[r] = y;
    y += h + GY;
  });
  const cols = Math.max(...boxes.map((b) => b.col)) + 1;
  const colX = (c) => x0 + c * (CW + GX);
  const Wt = colX(cols - 1) + CW + FP * maxD + M,
    H = y - GY + FP * maxD + M;
  const by = {};
  boxes.forEach((b) => {
    b.x = colX(b.col);
    b.y = rowY[b.row];
    b.cx = b.x + CW / 2;
    b.cy = b.y + b.h / 2;
    by[b.id] = b;
  });
  const frame = (r) => {
    const d = maxD - depth(r);
    const x = colX(r.cols[0]) - FP * d,
      X = colX(r.cols[1]) + CW + FP * d,
      yy = rowY[r.rows[0]] - FP * d - FT,
      Y = rowY[r.rows[1]] + rowH[r.rows[1]] + FP * d;
    return `<rect class="frame" x="${f(x)}" y="${f(yy)}" width="${f(X - x)}" height="${f(Y - yy)}" rx="${Math.min(T.rx, 6)}"/><text class="t-frame" x="${f(x + 10)}" y="${f(yy + FT * 0.7)}">${esc(r.title)}</text>`;
  };
  const box = (b) =>
    `<g class="n" transform="translate(${f(b.x)} ${f(b.y)})"><rect class="${b.kind ?? "box"}" width="${CW}" height="${f(b.h)}" rx="${Math.min(T.rx, 6)}"/>${bar(CW, TITLE, b.kind)}<text class="t-title ${titleCls(b.kind)}" x="${CW / 2}" y="${R(fT * 1.2)}" text-anchor="middle">${esc(b.title)}</text>${b.lines.map((s, i) => `<text class="t-v" x="${CW / 2}" y="${TITLE + LINE * (i + 1) - R(LINE * 0.3)}" text-anchor="middle">${esc(s)}</text>`).join("")}</g>`;
  const used = {}; // (id,side) 에 선이 몇 개 붙나 → 고르게 편다
  spec.edges.forEach((e) => {
    const [o, i] = sides(by[e.from], by[e.to], e);
    used[e.from + o] = (used[e.from + o] ?? 0) + 1;
    used[e.to + i] = (used[e.to + i] ?? 0) + 1;
  });
  const seen = {};
  const anchor = (b, s) => {
    const n = used[b.id + s],
      k = (seen[b.id + s] = (seen[b.id + s] ?? 0) + 1),
      t = k / (n + 1);
    return s === "e"
      ? [b.x + CW, b.y + b.h * t]
      : s === "w"
        ? [b.x, b.y + b.h * t]
        : s === "n"
          ? [b.x + CW * t, b.y]
          : [b.x + CW * t, b.y + b.h];
  };
  function sides(A, B, e) {
    if (e.out && e.in) return [e.out, e.in];
    if (A.row === B.row) return B.col > A.col ? ["e", "w"] : ["w", "e"];
    if (A.col === B.col) return B.row > A.row ? ["s", "n"] : ["n", "s"];
    return [B.col > A.col ? "e" : "w", B.row > A.row ? "n" : "s"];
  }
  const edge = (e) => {
    const A = by[e.from],
      B = by[e.to],
      [o, i] = sides(A, B, e),
      a = anchor(A, o),
      b = anchor(B, i),
      cls = e.kind ?? "";
    const horiz = (s) => s === "e" || s === "w";
    let pts;
    const opt = { both: cls.includes("both") };
    if (horiz(o) && horiz(i)) {
      if (o === i) {
        const x =
          o === "w"
            ? Math.min(A.x, B.x) - GX / 2
            : Math.max(A.x, B.x) + CW + GX / 2;
        pts = [a, [x, a[1]], [x, b[1]], b];
        opt.side = o;
        opt.t = 0.25;
      } else if (Math.abs(a[1] - b[1]) < 1) pts = [a, b];
      else {
        const x = (a[0] + b[0]) / 2;
        pts = [a, [x, a[1]], [x, b[1]], b];
      }
    } else if (!horiz(o) && !horiz(i)) {
      if (Math.abs(a[0] - b[0]) < 1) pts = [a, b];
      else {
        const yy = (a[1] + b[1]) / 2;
        pts = [a, [a[0], yy], [b[0], yy], b];
      }
    } else if (horiz(o)) pts = [a, [b[0], a[1]], b];
    else pts = [a, [a[0], b[1]], b];
    return edgeEl(p, pts, cls, e.label, opt);
  };
  return svgWrap(
    p,
    Wt,
    H,
    spec.caption,
    frames.map(frame).join("") +
      layers(spec.edges.map(edge), boxes.map(box).join("")),
  );
}

// ── 생성기 3: 시퀀스(sequence) ─────────────────────────────────────────
// 스펙: parts[{id, label, kind?}], msgs[{from, to, text, kind?('ret' | 'accent')}], blocks?[{from, to, label}] (from · to 는 msgs 의 번호, 0부터)
// 참여자 간격은 가장 긴 메시지에서. from === to 면 자기 자신에게 가는 고리.
function sequence(p, spec) {
  const { fsTitle: fT, fsLabel: fL, fsTag: fG } = T;
  const HH = R(fT * 2.3),
    M = 18,
    STEP = R(fL * 3.4);
  const HW = Math.ceil(
    Math.max(...spec.parts.map((q) => tw(q.label, fT, false, true))) + fT * 1.6,
  );
  const PX = Math.max(
    HW + 24,
    ...spec.msgs
      .filter((m) => m.from !== m.to)
      .map((m) => Math.ceil(tw(m.text, fL) + 30)),
  );
  const Y0 = M + HH + R(fL * 2.2);
  const parts = spec.parts.map((q, i) => ({ ...q, x: M + HW / 2 + i * PX }));
  const by = Object.fromEntries(parts.map((q) => [q.id, q]));
  const H = Y0 + spec.msgs.length * STEP + M,
    Wt = M * 2 + HW + (parts.length - 1) * PX;
  const head = (q) =>
    `<g class="n" transform="translate(${f(q.x - HW / 2)} ${M})"><rect class="${q.kind ?? "box"}" width="${HW}" height="${HH}" rx="${Math.min(T.rx, 6)}"/>${bar(HW, HH, q.kind)}<text class="t-title ${titleCls(q.kind)}" x="${HW / 2}" y="${R(HH * 0.66)}" text-anchor="middle">${esc(q.label)}</text></g><line class="life" x1="${f(q.x)}" y1="${M + HH}" x2="${f(q.x)}" y2="${f(H - M)}"/>`;
  const msg = (m, i) => {
    const y = Y0 + i * STEP,
      a = by[m.from],
      b = by[m.to],
      cls =
        "msg " +
        (m.kind === "ret" ? "ret" : m.kind === "accent" ? "accent" : "");
    if (a === b) {
      const w = R(fL * 2.2),
        h = R(fL * 1.2);
      return `<path class="edge ${cls}" d="${pathD([
        [a.x, y - h / 2],
        [a.x + w, y - h / 2],
        [a.x + w, y + h / 2],
        [a.x + 4, y + h / 2],
      ])}" marker-end="url(#${markerFor(p, cls)})"/><text class="t-label" x="${f(a.x + w + 6)}" y="${f(y + fL * 0.35)}">${esc(m.text)}</text>`;
    }
    const dir = b.x > a.x ? 1 : -1;
    return `<path class="edge ${cls}" d="M${f(a.x)} ${y} L${f(b.x - dir * 2)} ${y}" marker-end="url(#${markerFor(p, cls)})"/><text class="t-label" x="${f((a.x + b.x) / 2)}" y="${f(y - fL * 0.45)}" text-anchor="middle">${esc(m.text)}</text>`;
  };
  const block = (k) => {
    const ids = new Set();
    for (let i = k.from; i <= k.to; i++) {
      ids.add(spec.msgs[i].from);
      ids.add(spec.msgs[i].to);
    }
    const pad = R(fL * 2.8),
      th = R(fG * 1.4);
    const xs = [...ids].map((id) => by[id].x),
      x = Math.min(...xs) - pad,
      X = Math.max(...xs) + pad,
      y = Y0 + k.from * STEP - R(fL * 3.0),
      Y = Y0 + k.to * STEP + R(fL * 0.8);
    return `<rect class="frame" x="${f(x)}" y="${f(y)}" width="${f(X - x)}" height="${f(Y - y)}" rx="${Math.min(T.rx, 4)}"/><rect class="tag" x="${f(x)}" y="${f(y)}" width="${f(tw(k.label, fG, true) + fG * 3)}" height="${th}" rx="${Math.min(T.rx, 3)}"/><text class="t-tag" x="${f(x + fG * 0.8)}" y="${f(y + fG * 1.05)}">${esc(k.label)}</text>`;
  };
  return svgWrap(
    p,
    Wt,
    H,
    spec.caption,
    (spec.blocks ?? []).map(block).join("") +
      parts.map(head).join("") +
      spec.msgs.map(msg).join(""),
  );
}

// ── 생성기 4: 스윔레인(swimlane, 세로) ─────────────────────────────────
// 스펙: lanes[{id, label}], steps[{id, lane, text, sub?, kind?}], flows[{from, to, label?, kind?('back' | 'cond' …)}]
// 상자 폭은 가장 긴 단계 글에서, 레인 폭은 상자 + 되돌아가는 선 통로. 단계는 적힌 순서대로 내려간다.
function swimlane(p, spec) {
  const { fsTitle: fT, fsV: fV, fsLabel: fL } = T;
  const PAD = R(fV);
  const BW = Math.ceil(
    Math.max(
      ...spec.steps.map((s) =>
        Math.max(tw(s.text, fT, false, true), s.sub ? tw(s.sub, fV) : 0),
      ),
    ) +
      2 * PAD,
  );
  const BH = R(fT * 1.35 + fV * 1.35 + 12);
  const nBack = spec.flows.filter((e) =>
    (e.kind ?? "").includes("back"),
  ).length;
  const LW = BW + 2 * Math.max(24 + nBack * 10, R(fL * 2)),
    GY = R(fV * 2.4),
    HEAD = R(fT * 2.5),
    M = 16;
  const lanes = spec.lanes.map((l, i) => ({ ...l, x: M + i * LW }));
  const lx = Object.fromEntries(lanes.map((l) => [l.id, l.x]));
  const steps = spec.steps.map((s, i) => ({
    ...s,
    x: lx[s.lane] + (LW - BW) / 2,
    y: M + HEAD + 14 + i * (BH + GY),
    w: BW,
    h: BH,
  }));
  steps.forEach((s) => {
    s.cx = s.x + s.w / 2;
    s.cy = s.y + s.h / 2;
  });
  const by = Object.fromEntries(steps.map((s) => [s.id, s])),
    idx = Object.fromEntries(steps.map((s, i) => [s.id, i]));
  const H = M + HEAD + 14 + steps.length * (BH + GY) - GY + 14 + M,
    Wt = M * 2 + lanes.length * LW;
  const lane = (l, i) =>
    `<rect class="lane${i % 2 ? " alt" : ""}" x="${f(l.x)}" y="${M}" width="${LW}" height="${f(H - 2 * M)}"/>${T.titleBar ? `<rect class="bar" x="${f(l.x)}" y="${M}" width="${LW}" height="${HEAD}"/>` : ""}<text class="t-lane ${T.titleBar ? "on-bar" : ""}" x="${f(l.x + LW / 2)}" y="${f(M + HEAD * 0.66)}" text-anchor="middle">${esc(l.label)}</text><line class="sep" x1="${f(l.x)}" y1="${M + HEAD}" x2="${f(l.x + LW)}" y2="${M + HEAD}"/>`;
  const step = (s) =>
    `<g class="n" transform="translate(${f(s.x)} ${f(s.y)})"><rect class="${s.kind ?? "box"}" width="${s.w}" height="${s.h}" rx="${s.kind === "io" ? T.rxPill : T.rx}"/><text class="t-title ${s.kind === "lead" && !T.titleBar ? "on-lead" : ""}" x="${s.w / 2}" y="${s.sub ? R(fT * 1.15) + 4 : R(BH * 0.62)}" text-anchor="middle">${esc(s.text)}</text>${s.sub ? `<text class="t-v" x="${s.w / 2}" y="${BH - R(fV * 0.6)}" text-anchor="middle">${esc(s.sub)}</text>` : ""}</g>`;
  let bk = 0;
  // 되돌아가는 선: 같은 레인이면 왼쪽 통로(라벨은 왼쪽 빈 레인 쪽), 오른쪽 레인으로 가면 오른쪽 통로
  const flow = (e) => {
    const A = by[e.from],
      B = by[e.to],
      cls = e.kind ?? "";
    let pts,
      opt = {};
    if (idx[e.to] > idx[e.from]) {
      if (A.lane === B.lane)
        pts = [
          [A.cx, A.y + A.h],
          [B.cx, B.y],
        ];
      else {
        const yy = A.y + A.h + GY / 2;
        pts = [
          [A.cx, A.y + A.h],
          [A.cx, yy],
          [B.cx, yy],
          [B.cx, B.y],
        ];
      }
    } else if (B.x > A.x) {
      const x = A.x + A.w + 12 + bk++ * 10;
      pts = [
        [A.x + A.w, A.cy],
        [x, A.cy],
        [x, B.cy],
        [B.x, B.cy],
      ];
      opt.t = 0.25;
    } else {
      const x = A.x - 12 - bk++ * 10;
      pts = [
        [A.x, A.cy],
        [x, A.cy],
        [x, B.cy],
        [B.lane === A.lane ? B.x : B.x + B.w, B.cy],
      ];
      opt.side = "w";
      opt.t = 0.25;
    }
    return edgeEl(p, pts, cls, e.label, opt);
  };
  return svgWrap(
    p,
    Wt,
    H,
    spec.caption,
    lanes.map(lane).join("") +
      layers(spec.flows.map(flow), steps.map(step).join("")),
  );
}

// ── 등록 · 검증 · 진입점 ───────────────────────────────────────────────
// 생성기마다: 그리기(draw), 스펙 검증(check: 문제 문자열 배열), 한 줄 설명(fit)
const ids = (arr, key = "id") => arr.map((x) => x[key]);
const dup = (arr) => arr.filter((x, i) => arr.indexOf(x) !== i);
const refs = (edges, known, a = "from", b = "to") =>
  edges.flatMap((e, i) =>
    [a, b]
      .filter((k) => !known.has(e[k]))
      .map((k) => `edges[${i}].${k} = "${e[k]}" 은 없는 id`),
  );

export const GENERATORS = {
  boxflow: {
    draw: boxflow,
    fit: "상자 안에 키 · 값 줄이 있는 흐름 그래프. 되돌아가는 선(back) · 조건 선(cond).",
    check: (s) => {
      const p = [];
      if (!s.nodes?.length) p.push("nodes 가 비었다");
      if (!s.edges) p.push("edges 가 없다");
      if (p.length) return p;
      p.push(...dup(ids(s.nodes)).map((d) => `nodes id 중복: ${d}`));
      p.push(...refs(s.edges, new Set(ids(s.nodes))));
      s.nodes.forEach((n, i) => {
        if (!Number.isInteger(n.col) || !Number.isInteger(n.row))
          p.push(`nodes[${i}] ${n.id}: col · row 는 정수`);
      });
      return p;
    },
  },
  gridmap: {
    draw: gridmap,
    fit: "무엇이 어느 칸에 있고 무엇과 이어지는지. 프레임이 경계를 묶는다.",
    check: (s) => {
      const p = [];
      if (!s.boxes?.length) p.push("boxes 가 비었다");
      if (!s.edges) p.push("edges 가 없다");
      if (p.length) return p;
      p.push(...dup(ids(s.boxes)).map((d) => `boxes id 중복: ${d}`));
      p.push(...refs(s.edges, new Set(ids(s.boxes))));
      (s.frames ?? []).forEach((r, i) => {
        if (!(r.cols?.length === 2 && r.rows?.length === 2))
          p.push(`frames[${i}]: cols · rows 는 [시작, 끝]`);
      });
      return p;
    },
  },
  sequence: {
    draw: sequence,
    fit: "요청 하나가 참여자 사이를 오가는 순서. loop 같은 묶음(blocks).",
    check: (s) => {
      const p = [];
      if (!s.parts?.length) p.push("parts 가 비었다");
      if (!s.msgs?.length) p.push("msgs 가 비었다");
      if (p.length) return p;
      p.push(...dup(ids(s.parts)).map((d) => `parts id 중복: ${d}`));
      p.push(
        ...refs(s.msgs, new Set(ids(s.parts))).map((x) =>
          x.replace("edges", "msgs"),
        ),
      );
      (s.blocks ?? []).forEach((b, i) => {
        if (!(b.from >= 0 && b.to < s.msgs.length && b.from <= b.to))
          p.push(
            `blocks[${i}]: from · to 는 msgs 번호(0~${s.msgs.length - 1})`,
          );
      });
      return p;
    },
  },
  swimlane: {
    draw: swimlane,
    fit: "누가(레인) 하는지와 순서를 한 번에. 단계는 적힌 순서대로 내려간다.",
    check: (s) => {
      const p = [];
      if (!s.lanes?.length) p.push("lanes 가 비었다");
      if (!s.steps?.length) p.push("steps 가 비었다");
      if (!s.flows) p.push("flows 가 없다");
      if (p.length) return p;
      const L = new Set(ids(s.lanes));
      p.push(...dup(ids(s.steps)).map((d) => `steps id 중복: ${d}`));
      p.push(
        ...refs(s.flows, new Set(ids(s.steps))).map((x) =>
          x.replace("edges", "flows"),
        ),
      );
      s.steps.forEach((st, i) => {
        if (!L.has(st.lane))
          p.push(`steps[${i}] ${st.id}: lane "${st.lane}" 은 없는 레인`);
      });
      return p;
    },
  },
};

// geo(스타일의 생성기 인자) → 글꼴 크기 여섯을 더한 T
export const sized = (key, g) => ({
  ...g,
  key,
  fs: g.u,
  fsTitle: g.u * g.r.title,
  fsV: g.u * g.r.v,
  fsK: g.u * g.r.k,
  fsLabel: g.u * g.r.label,
  fsTag: g.u * g.r.tag,
});

// 진입점: kind 의 생성기로 spec 을 그린다. idPrefix 는 marker · pattern id 앞에 붙는다(한 페이지 안에서 유일해야 한다).
export function render(kind, spec, geoSized, idPrefix) {
  const g = GENERATORS[kind];
  if (!g)
    throw new Error(
      `생성기 "${kind}" 가 없다. 있는 것: ${Object.keys(GENERATORS).join(", ")}. 없으면 lib/generators.mjs 에 생성기부터 만든다.`,
    );
  const problems = g.check(spec);
  if (problems.length)
    throw new Error(`스펙 오류(${kind}):\n  - ${problems.join("\n  - ")}`);
  T = geoSized;
  return g.draw(idPrefix, spec);
}
