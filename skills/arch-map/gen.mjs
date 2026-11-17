#!/usr/bin/env node
// 호출 지도 생성기. 스펙(JSON)의 상자 자리와 호출 목록을 받아 줄을 긋고 template.html 을 채워 HTML 한 장을 쓴다.
//
//   node gen.mjs <스펙.json> [--out 지도.html] [--dry] [--artifact] [--trials 60]
//
//   --dry       그려 보고 숫자만 찍는다
//   --artifact  Artifact 에 올릴 꼴로 쓴다 (문서 머리를 걷고 IBM Plex 글꼴 줄을 넣는다)
//
// 줄 긋는 규칙: 호출마다 제 줄 하나 · 줄끼리 16px · 한 점에 꺾임 하나 · 꺾인 점끼리 32px · 넘는 자리는 다리.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(k);
const opt = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : null;
};
const specFile = argv.find(
  (a, i) => !a.startsWith("--") && !["--out", "--trials"].includes(argv[i - 1]),
);
if (!specFile) {
  console.error(
    "쓰기: node gen.mjs <스펙.json> [--out 지도.html] [--dry] [--artifact]",
  );
  process.exit(1);
}
const spec = JSON.parse(fs.readFileSync(specFile, "utf8"));
const outFile =
  opt("--out") || specFile.replace(/(\.spec)?\.json$/, "") + ".html";
const TRIALS = +(opt("--trials") || 60);

// ── 스펙 검사
const errs = [];
const nodes = spec.nodes || [],
  calls = spec.calls || [];
const pos = {};
for (const n of nodes) {
  if (!n.id) {
    errs.push("id 없는 상자가 있다");
    continue;
  }
  if (pos[n.id]) errs.push("상자 id 가 겹친다: " + n.id);
  pos[n.id] = n;
  for (const k of ["x", "y", "w", "h"])
    if (!Number.isInteger(n[k]) || n[k] % 8)
      errs.push(n.id + " 의 " + k + " 는 8 의 배수인 정수다: " + n[k]);
  if (!n.frame && (n.w < 48 || n.h < 48))
    errs.push(n.id + " 는 48 × 48 보다 작다");
  if (!n.label) errs.push(n.id + " 에 label 이 없다");
  if (!n.one) errs.push(n.id + " 에 한 줄 설명 one 이 없다");
}
const seen = new Set();
for (const c of calls) {
  if (!pos[c[0]] || !pos[c[1]])
    errs.push("없는 상자를 잇는 호출: " + c[0] + " → " + c[1]);
  if (seen.has(c[0] + ">" + c[1]))
    errs.push("같은 호출이 두 번 있다: " + c[0] + " → " + c[1]);
  seen.add(c[0] + ">" + c[1]);
}
const badgeList = spec.badges || [];
const BADGE = {};
const BADGE_COLORS = ["blue", "orange", "green", "purple", "amber", "red"];
for (const b of badgeList) {
  if (!pos[b.to]) errs.push("표시가 없는 상자를 가리킨다: " + b.to);
  if (!b.mark || !b.text) errs.push("표시에는 mark 와 text 가 있다: " + b.to);
  if (b.color && !BADGE_COLORS.includes(b.color))
    errs.push(
      "표시 색은 " + BADGE_COLORS.join(" · ") + " 가운데 하나다: " + b.color,
    );
  BADGE[b.to] = b.mark;
}
for (const group of spec.permute || []) {
  if (group.length > 5)
    errs.push("permute 묶음은 다섯 개까지다: " + group.join(" "));
  for (const id of group)
    if (!pos[id]) errs.push("permute 에 없는 상자: " + id);
  if (
    group.every((id) => pos[id]) &&
    group.some(
      (id) => pos[id].w !== pos[group[0]].w || pos[id].h !== pos[group[0]].h,
    )
  )
    errs.push("permute 묶음은 크기가 같은 상자끼리다: " + group.join(" "));
}
for (const k of Object.keys(spec.flows || {})) {
  if (!pos[k]) errs.push("플로우가 없는 상자에 달렸다: " + k);
  for (const [i, s] of (spec.flows[k].steps || []).entries())
    for (const e of s.e || []) {
      if (!seen.has(e[0] + ">" + e[1]))
        errs.push(
          "플로우 " +
            k +
            " " +
            (i + 1) +
            " 번이 없는 호출을 가리킨다: " +
            e[0] +
            " → " +
            e[1],
        );
    }
}
const CLS = {
  plain: "s-box",
  blue: "s-gate",
  orange: "s-graph",
  green: "s-mat",
  purple: "s-judge",
  amber: "s-ext",
  red: "s-adm",
  teal: "s-f1",
  pink: "s-f2",
  olive: "s-f3",
  sky: "s-f4",
  slate: "s-f5",
  rose: "s-f6",
};
const SW = {
  plain: "",
  blue: "gate",
  orange: "graph",
  green: "mat",
  purple: "judge",
  amber: "ext",
  red: "adm",
  teal: "f1",
  pink: "f2",
  olive: "f3",
  sky: "f4",
  slate: "f5",
  rose: "f6",
};
for (const n of nodes)
  if (n.color && !CLS[n.color])
    errs.push(
      n.id +
        " 의 색은 " +
        Object.keys(CLS).join(" · ") +
        " 가운데 하나다: " +
        n.color,
    );
for (const l of spec.legend || [])
  for (const c of l.colors || [])
    if (!(c in SW)) errs.push("범례 색이 없는 이름이다: " + c);
if (errs.length) {
  console.error("스펙이 맞지 않는다:\n  " + errs.join("\n  "));
  process.exit(1);
}

// ── 캔버스와 격자
const key = spec.key || null;
const keyRows = key
  ? badgeList.length + 1 + (Object.keys(spec.flows || {}).length ? 1 : 0)
  : 0;
const W = Math.max(...nodes.map((n) => n.x + n.w), key ? key.x + 440 : 0) + 24;
const Hh =
  Math.max(...nodes.map((n) => n.y + n.h), key ? key.y + keyRows * 34 : 0) + 24;
const C = 8,
  GWd = Math.ceil(W / C) + 1,
  GHt = Math.ceil(Hh / C) + 1;
const boxes = nodes.filter((n) => !n.frame),
  frames = nodes.filter((n) => n.frame);
const inside = new Array(GWd * GHt).fill(null),
  ring = new Array(GWd * GHt).fill(null);
const RING = 2;
function grid() {
  inside.fill(null);
  ring.fill(null);
  for (const b of boxes) {
    const i0 = b.x / C,
      i1 = (b.x + b.w) / C,
      j0 = b.y / C,
      j1 = (b.y + b.h) / C;
    for (let i = Math.max(0, i0 - RING); i <= Math.min(GWd - 1, i1 + RING); i++)
      for (
        let j = Math.max(0, j0 - RING);
        j <= Math.min(GHt - 1, j1 + RING);
        j++
      ) {
        const k = i * GHt + j;
        if (i > i0 && i < i1 && j > j0 && j < j1) inside[k] = b.id;
        else if (i >= i0 && i <= i1 && j >= j0 && j <= j1)
          inside[k] = inside[k] || "|" + b.id; // 테두리
        else if (!ring[k]) ring[k] = b.id;
      }
  }
  for (const f of frames) {
    // 틀 이름 자리는 줄이 비켜 간다
    const wide = 24 + 14 * String(f.label).length;
    for (
      let i = Math.floor((f.x + 8) / C);
      i <= Math.min(GWd - 1, Math.ceil((f.x + 8 + wide) / C));
      i++
    )
      for (
        let j = Math.floor(f.y / C) + 1;
        j <= Math.ceil((f.y + 36) / C);
        j++
      ) {
        const k = i * GHt + j;
        if (inside[k] === null) inside[k] = "#label";
      }
  }
}
const occH = new Array(GWd * GHt).fill(null),
  occV = new Array(GWd * GHt).fill(null);
// 한 점에는 꺾임 하나: 칸마다 이미 그은 줄의 꺾임을 적어 둔다. 그 칸과 곁(같은 가로줄 · 세로줄 NEAR 칸 안)에서는 꺾지 않는다.
const bendAt = new Set();
const NEAR = 4;
function nearBend(i, j) {
  if (bendAt.has(i * GHt + j)) return true;
  for (let n = 1; n <= NEAR; n++) {
    if (bendAt.has((i + n) * GHt + j) || bendAt.has((i - n) * GHt + j))
      return true;
    if (j + n < GHt && bendAt.has(i * GHt + j + n)) return true;
    if (j - n >= 0 && bendAt.has(i * GHt + j - n)) return true;
  }
  return false;
}
grid();

// ── 길 찾기: 격자 위 최단 경로(Dijkstra). 꺾임과 교차에 값을 매긴다.
const DI = [1, 0, -1, 0],
  DJ = [0, 1, 0, -1];
const SIDE = { right: 0, bottom: 1, left: 2, top: 3 };
function route(a, b, sides, relax) {
  const A = pos[a],
    B = pos[b],
    me = a + ">" + b;
  const keyOf = (i, j, d) => (i * GHt + j) * 4 + d;
  const dist = new Map(),
    prev = new Map(),
    heap = [];
  const push = (c, k) => {
    heap.push([c, k]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const first = heap[0],
      last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1,
          r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return first;
  };
  const border = (N, d) => {
    // d: 나가는 방향. 그 변의 격자점
    const out = [],
      m = 2;
    if (d === 0)
      for (let j = N.y / C + m; j <= (N.y + N.h) / C - m; j++)
        out.push([(N.x + N.w) / C, j]);
    if (d === 2)
      for (let j = N.y / C + m; j <= (N.y + N.h) / C - m; j++)
        out.push([N.x / C, j]);
    if (d === 1)
      for (let i = N.x / C + m; i <= (N.x + N.w) / C - m; i++)
        out.push([i, (N.y + N.h) / C]);
    if (d === 3)
      for (let i = N.x / C + m; i <= (N.x + N.w) / C - m; i++)
        out.push([i, N.y / C]);
    return out;
  };
  const free = (i, j, d) => {
    // 이 칸을 d 방향 줄이 지나도 되는가. 다른 줄이 쓴 칸과 그 옆 칸은 쓰지 않는다
    const k = i * GHt + j,
      horiz = d % 2 === 0,
      own = horiz ? occH : occV;
    if (own[k]) return false;
    if (!relax) {
      const k1 = horiz ? k - 1 : k - GHt,
        k2 = horiz ? k + 1 : k + GHt;
      if ((j > 0 || !horiz) && own[k1]) return false;
      if (own[k2]) return false;
    }
    return true;
  };
  const goals = new Set();
  for (let d = 0; d < 4; d++)
    for (const [i, j] of border(B, d)) goals.add(keyOf(i, j, (d + 2) % 4));
  for (const d of sides)
    for (const [i, j] of border(A, d)) {
      if (!free(i, j, d)) continue;
      const k = keyOf(i, j, d);
      dist.set(k, 0);
      push(0, k);
    }
  let goal = null;
  while (heap.length) {
    const [c, k] = pop();
    if (c > (dist.get(k) ?? Infinity)) continue;
    if (goals.has(k)) {
      goal = k;
      break;
    }
    const d = k % 4,
      ij = (k - d) / 4,
      j = ij % GHt,
      i = (ij - j) / GHt,
      cell = i * GHt + j;
    const onBorder = inside[cell] !== null,
      inRing = ring[cell] !== null && !onBorder;
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d + 2) % 4) continue;
      if (nd !== d) {
        if (onBorder || inRing) continue; // 상자 곁에서는 꺾지 않는다
        if (occH[cell] || occV[cell]) continue; // 다른 줄 위에서 꺾지 않는다
        if (nearBend(i, j)) continue; // 다른 줄이 꺾인 점과 그 곁에서 꺾지 않는다
      }
      const ni = i + DI[nd],
        nj = j + DJ[nd];
      if (ni < 1 || nj < 1 || ni >= GWd - 1 || nj >= GHt - 1) continue;
      const nc = ni * GHt + nj,
        ins = inside[nc];
      if (ins !== null) {
        if (ins !== "|" + b || !goals.has(keyOf(ni, nj, nd))) continue;
      } // 상자 안과 틀 이름 자리는 막힌다. 불리는 상자의 테두리만 들어간다
      else if (ring[nc] && ring[nc] !== a && ring[nc] !== b) continue;
      if (!free(ni, nj, nd)) continue;
      const other = nd % 2 === 0 ? occV : occH;
      const step = C + (nd !== d ? 70 : 0) + (other[nc] ? 34 : 0);
      const nk = keyOf(ni, nj, nd),
        cc = c + step;
      if (cc < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, cc);
        prev.set(nk, k);
        push(cc, nk);
      }
    }
  }
  if (goal === null) return null;
  const cells = [];
  for (let k = goal; k !== undefined; k = prev.get(k)) {
    const d = k % 4,
      ij = (k - d) / 4,
      j = ij % GHt,
      i = (ij - j) / GHt;
    cells.push([i, j, d]);
  }
  cells.reverse();
  for (let q = 0; q < cells.length; q++) {
    const [i, j, d] = cells[q],
      k = i * GHt + j;
    if (d % 2 === 0) occH[k] = me;
    else occV[k] = me;
    if (q + 1 < cells.length && cells[q + 1][2] !== d) {
      if (cells[q + 1][2] % 2 === 0) occH[k] = me;
      else occV[k] = me;
      bendAt.add(k);
    }
  }
  const pts = [[cells[0][0] * C, cells[0][1] * C]];
  for (let q = 1; q < cells.length - 1; q++)
    if (cells[q + 1][2] !== cells[q][2])
      pts.push([cells[q][0] * C, cells[q][1] * C]);
  const last = cells[cells.length - 1],
    ld = last[2];
  pts.push([last[0] * C - DI[ld] * 2, last[1] * C - DJ[ld] * 2]);
  return pts;
}

// ── 줄과 표시를 가른다. 들어오는 곳(entry)의 줄은 나머지를 다 그은 뒤에 긋는다.
const cx = (id) => pos[id].x + pos[id].w / 2,
  cy = (id) => pos[id].y + pos[id].h / 2;
const far = (a, b) => Math.abs(cx(a) - cx(b)) + Math.abs(cy(a) - cy(b));
const badges = [],
  inner = [],
  entry = [];
for (const [a, b] of calls) {
  if (BADGE[b]) badges.push([a, b]);
  else if (pos[a].entry) entry.push([a, b]);
  else inner.push([a, b]);
}
inner.sort((p, q) => far(p[0], p[1]) - far(q[0], q[1]));
const sidesOf = (id) =>
  pos[id].out
    ? pos[id].out.map((s) => SIDE[s])
    : pos[id].entry
      ? [0]
      : [0, 1, 2, 3];

// 교차: 가로 토막이 다른 줄의 세로 토막을 넘는 자리
function crossings(res) {
  const Hs = [],
    Vs = [];
  res.forEach((e, n) => {
    for (let q = 0; q + 1 < e.pts.length; q++) {
      const [x1, y1] = e.pts[q],
        [x2, y2] = e.pts[q + 1];
      if (y1 === y2)
        Hs.push({ n, q, y: y1, lo: Math.min(x1, x2), hi: Math.max(x1, x2) });
      else Vs.push({ n, x: x1, lo: Math.min(y1, y2), hi: Math.max(y1, y2) });
    }
  });
  const spots = new Set(),
    list = [];
  for (const h of Hs)
    for (const v of Vs)
      if (h.n !== v.n && v.x > h.lo && v.x < h.hi && h.y > v.lo && h.y < v.hi) {
        list.push({ n: h.n, q: h.q, x: v.x });
        spots.add(v.x + "," + h.y);
      }
  return { list, count: spots.size };
}
function runAll(order) {
  occH.fill(null);
  occV.fill(null);
  bendAt.clear();
  const res = [],
    fl = [];
  let bd = 0;
  for (const [list, isEntry] of [
    [order, 0],
    [entry, 1],
  ])
    for (const [a, b] of list) {
      const pts =
        route(a, b, sidesOf(a), false) || route(a, b, sidesOf(a), true);
      if (!pts) {
        fl.push(a + " → " + b);
        continue;
      }
      bd += pts.length - 2;
      res.push({ a, b, pts, entry: isEntry });
    }
  const X = crossings(res);
  return {
    res,
    fl,
    bends: bd,
    X,
    score: fl.length * 10000 + X.count * 30 + bd,
    order,
  };
}

// 자리 바꿔 보기: permute 묶음마다 상자 자리를 모두 돌려 보고 점수가 낮은 쪽을 고른다
const perms = (a) =>
  a.length < 2
    ? [a]
    : a.flatMap((x, i) =>
        perms([...a.slice(0, i), ...a.slice(i + 1)]).map((p) => [x, ...p]),
      );
let best = runAll(inner);
const first = best.score;
for (const group of spec.permute || []) {
  const slots = group.map((id) => [pos[id].x, pos[id].y]);
  let pick = group;
  for (const p of perms(group)) {
    p.forEach((id, k) => {
      [pos[id].x, pos[id].y] = slots[k];
    });
    grid();
    const r = runAll(inner);
    if (r.score < best.score) {
      best = r;
      pick = p;
    }
  }
  pick.forEach((id, k) => {
    [pos[id].x, pos[id].y] = slots[k];
  });
  grid();
  if (pick !== group) console.log("자리 바꿈: " + pick.join(" "));
}
// 긋는 순서: 순서를 바꿔 가며 교차와 꺾임이 적은 쪽을 고른다 (씨앗이 고정이라 결과가 늘 같다)
let seed = 7;
const rnd = (n) => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return Math.floor((seed / 2147483648) * n);
};
for (let t = 0; t < TRIALS && inner.length > 1; t++) {
  const o = best.order.slice(),
    i = rnd(o.length),
    j = rnd(o.length);
  if (i === j) continue;
  if (t % 2) {
    const [m] = o.splice(i, 1);
    o.splice(j, 0, m);
  } else {
    [o[i], o[j]] = [o[j], o[i]];
  }
  const r = runAll(o);
  if (r.score < best.score) best = r;
}
best = runAll(best.order);

// ── 줄 모양: 넘는 자리에 다리를 놓는다
const JR = 5;
const jumpPath = (e, n) => {
  let s = "M" + e.pts[0].join(",");
  for (let q = 0; q + 1 < e.pts.length; q++) {
    const [x1, y1] = e.pts[q],
      [x2, y2] = e.pts[q + 1];
    if (y1 === y2) {
      const dir = x2 > x1 ? 1 : -1;
      const xs = [
        ...new Set(
          best.X.list.filter((c) => c.n === n && c.q === q).map((c) => c.x),
        ),
      ].sort((p, r) => dir * (p - r));
      let last = null;
      for (const x of xs) {
        if (last !== null && Math.abs(x - last) < 2 * JR + 1) continue;
        if (Math.abs(x - x1) <= JR || Math.abs(x - x2) <= JR) continue;
        s +=
          " L" +
          (x - dir * JR) +
          "," +
          y1 +
          " A" +
          JR +
          "," +
          JR +
          " 0 0 " +
          (dir > 0 ? 1 : 0) +
          " " +
          (x + dir * JR) +
          "," +
          y1;
        last = x;
      }
    }
    s += " L" + x2 + "," + y2;
  }
  return s;
};
const edges = [];
best.res.forEach((r, n) => {
  const e = { a: r.a, b: r.b, d: jumpPath(r, n) };
  if (r.entry) e.api = 1;
  edges.push(e);
});
const slot = {};
for (const [a, b] of badges) {
  const n = pos[a],
    k = (slot[a] = (slot[a] || 0) + 1);
  edges.push({
    a,
    b,
    badge: BADGE[b],
    x: n.entry ? n.x + n.w - 4 - 22 * k : n.x + n.w + 4 - 24 * k,
    y: n.entry ? n.y + n.h / 2 : n.y + 20,
  });
}

console.log(
  "크기 " +
    W +
    " × " +
    Hh +
    " · 상자 " +
    nodes.length +
    " · 호출 " +
    calls.length +
    " (줄 " +
    best.res.length +
    " · 표시 " +
    badges.length +
    ")" +
    " · 꺾임 " +
    best.bends +
    " · 교차 " +
    best.X.count +
    " · 점수 " +
    first +
    " → " +
    best.score +
    " · 못 그은 호출 " +
    (best.fl.length ? best.fl.join(", ") : "없음"),
);

// ── 틀 채우기
if (!flag("--dry")) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const NODES = nodes.map((n) => {
    const o = {
      id: n.id,
      x: n.x,
      y: n.y,
      w: n.w,
      h: n.h,
      cls: n.frame && !n.color ? "s-frame" : CLS[n.color || "plain"],
      label: n.label,
    };
    if (n.frame) o.frame = true;
    else if (n.small) o.small = 1;
    else if (!n.entry) o.big = 1;
    if (BADGE[n.id]) o.mark = BADGE[n.id];
    return o;
  });
  const D = {},
    A = {},
    AC = {};
  for (const n of nodes) {
    const d = {
      kind: n.kind || (n.frame ? "묶음" : n.entry ? "들어오는 곳" : "상자"),
      title: n.title || n.label,
    };
    for (const k of ["mono", "one", "does", "paths", "warn", "ref", "steps"])
      if (n[k] !== undefined) d[k] = n[k];
    D[n.id] = d;
    if (n.inner) {
      A[n.id] = n.inner.cols;
      if (n.inner.cap) AC[n.id] = n.inner.cap;
    }
  }
  const BADGES = badgeList.map((b) => ({
    to: b.to,
    mark: b.mark,
    color: b.color || "blue",
    text: b.text,
  }));
  const LEGEND = (spec.legend || []).map((l) => ({
    sw: (l.colors || ["plain"]).map((c) => SW[c]),
    text: l.text,
  }));
  const META = { calls: calls.length, intro: spec.intro || "", key };
  const arr = (a) => a.map((x) => "    " + JSON.stringify(x)).join(",\n");
  const obj = (o) =>
    Object.keys(o)
      .map((k) => "    " + JSON.stringify(k) + ": " + JSON.stringify(o[k]))
      .join(",\n");
  let s = fs.readFileSync(path.join(here, "template.html"), "utf8");
  const put = (name, open, close, body) => {
    const re = new RegExp(
      "  var " + name + " = \\" + open + "\\n  \\" + close + ";",
    );
    if (!re.test(s))
      throw new Error("template.html 에 " + name + " 자리가 없다");
    s = s.replace(
      re,
      () => "  var " + name + " = " + open + "\n" + body + "\n  " + close + ";",
    );
  };
  put("NODES", "[", "]", arr(NODES));
  put("EDGES", "[", "]", arr(edges));
  put("D", "{", "}", obj(D));
  put("A", "{", "}", obj(A));
  put("AC", "{", "}", obj(AC));
  put("FLOWS", "{", "}", obj(spec.flows || {}));
  put("BADGES", "[", "]", arr(BADGES));
  put("LEGEND", "[", "]", arr(LEGEND));
  put("META", "{", "}", obj(META));
  const title = spec.title || "아키텍처 지도";
  const mono =
    spec.titleMono && title.startsWith(spec.titleMono) ? spec.titleMono : null;
  const fill = {
    "@TITLE@": esc(title),
    "@H1@": mono
      ? '<span class="m">' +
        esc(mono) +
        "</span>" +
        esc(title.slice(mono.length))
      : esc(title),
    "@BASIS@": spec.basis || "",
    "@W@": W,
    "@H@": Hh,
    "@MAXW@": W + 4,
    "@ARIA@": esc(title + ". 상자를 누르면 설명이 열린다."),
  };
  for (const k of Object.keys(fill)) s = s.split(k).join(String(fill[k]));
  if (flag("--artifact")) {
    const fonts = [
      '<meta name="claude:viewport-fit-sides" content="cover">',
      '<link rel="preconnect" href="https://fonts.googleapis.com">',
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans+KR:wght@400;600;700&display=swap">',
    ].join("\n");
    s =
      s.slice(s.indexOf("<title>"), s.lastIndexOf("</html>")).trimEnd() + "\n";
    s = s.replace(/(<title>[^\n]*<\/title>\n)/, (m, t) => t + fonts + "\n");
  }
  fs.writeFileSync(outFile, s);
  console.log(outFile + " 에 썼다");
}
if (best.fl.length) process.exit(1);
