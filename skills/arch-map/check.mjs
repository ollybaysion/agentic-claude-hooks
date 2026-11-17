#!/usr/bin/env node
// gen.mjs 가 쓴 호출 지도(HTML)의 데이터와 줄을 검사한다. 걸리면 줄마다 찍고 1 로 끝난다.
//
//   node check.mjs <지도.html>
//
// 보는 것
//   데이터  상자마다 설명(D)이 있다 · 줄의 양 끝 · 안쪽 구조(A) · 플로우(FLOWS)가 있는 상자와 줄만 가리킨다
//   꺾임    두 줄의 꺾인 점이 한 점에서 만나는 자리가 0 이다
//   겹침    두 줄이 같은 토막을 같이 지나는 자리가 0 이다 (호출마다 제 줄)
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("쓰기: node check.mjs <지도.html>");
  process.exit(1);
}
const src = fs.readFileSync(file, "utf8");
const pick = (n) => {
  const m = new RegExp("  var " + n + " = ([\\[{][\\s\\S]*?\\n  [\\]}]);").exec(
    src,
  );
  if (!m) throw new Error("html 에서 " + n + " 를 찾지 못했다");
  return new Function("return (" + m[1] + ")")();
};
const NODES = pick("NODES"),
  EDGES = pick("EDGES"),
  D = pick("D"),
  A = pick("A"),
  FLOWS = pick("FLOWS");
const ids = new Set(NODES.map((n) => n.id));
const bad = [];

// ── 데이터
NODES.forEach((n) => {
  if (!D[n.id]) bad.push("설명 없음: " + n.id);
});
Object.keys(D).forEach((k) => {
  if (!ids.has(k)) bad.push("상자 없는 설명: " + k);
});
EDGES.forEach((e) => {
  if (!ids.has(e.a) || !ids.has(e.b))
    bad.push("상자 없는 줄: " + e.a + " → " + e.b);
});
Object.keys(A).forEach((k) => {
  if (!ids.has(k)) bad.push("상자 없는 안쪽 구조: " + k);
  A[k].forEach((col) =>
    col.slice(2).forEach((it) => {
      const m = /^@(\S+) /.exec(it);
      if (m && !ids.has(m[1]))
        bad.push("안쪽 구조 " + k + " 가 없는 상자를 가리킨다: " + m[1]);
    }),
  );
});
const has = new Set(EDGES.map((e) => e.a + ">" + e.b));
Object.keys(FLOWS).forEach((k) => {
  if (!ids.has(k)) bad.push("상자 없는 플로우: " + k);
  FLOWS[k].steps.forEach((s, i) =>
    s.e.forEach((e) => {
      if (!has.has(e[0] + ">" + e[1]))
        bad.push(
          "플로우 " +
            k +
            " " +
            (i + 1) +
            " 번이 없는 줄을 가리킨다: " +
            e[0] +
            " → " +
            e[1],
        );
    }),
  );
});

// ── 줄의 꼭짓점. 다리(A)는 끝점만 읽고, 한 줄로 이어진 점은 걷어 낸다.
const lines = [];
for (const e of EDGES) {
  if (!e.d) continue;
  const raw = [];
  const re =
    /([ML])\s*(-?[\d.]+),(-?[\d.]+)|A[^ML]*?(-?[\d.]+),(-?[\d.]+)\s*(?=[ML]|$)/g;
  let t;
  while ((t = re.exec(e.d))) raw.push(t[1] ? [+t[2], +t[3]] : [+t[4], +t[5]]);
  const pts = raw.filter((p, i) => {
    if (i === 0 || i === raw.length - 1) return true;
    const a = raw[i - 1],
      c = raw[i + 1];
    return !(
      (a[0] === p[0] && p[0] === c[0]) ||
      (a[1] === p[1] && p[1] === c[1])
    );
  });
  lines.push({ name: e.a + " → " + e.b, pts });
}

// ── 꺾임: 한 점에 꺾임 하나
const dir = (p, q) =>
  q[0] > p[0] ? "E" : q[0] < p[0] ? "W" : q[1] > p[1] ? "S" : "N";
const at = {};
lines.forEach((l) => {
  for (let i = 1; i + 1 < l.pts.length; i++) {
    const p = l.pts[i];
    (at[p.join(",")] = at[p.join(",")] || []).push(
      l.name + " " + dir(l.pts[i - 1], p) + ">" + dir(p, l.pts[i + 1]),
    );
  }
});
let bends = 0;
for (const k in at)
  if (at[k].length > 1) {
    bends++;
    bad.push("꺾인 점이 겹친다 (" + k + "): " + at[k].join(" | "));
  }

// ── 겹침: 같은 토막을 두 줄이 지나지 않는다
const segs = [];
lines.forEach((l, n) => {
  for (let i = 0; i + 1 < l.pts.length; i++) {
    const p = l.pts[i],
      q = l.pts[i + 1],
      h = p[1] === q[1];
    segs.push({
      n,
      h,
      at: h ? p[1] : p[0],
      lo: Math.min(h ? p[0] : p[1], h ? q[0] : q[1]),
      hi: Math.max(h ? p[0] : p[1], h ? q[0] : q[1]),
    });
  }
});
let overlaps = 0;
for (let i = 0; i < segs.length; i++)
  for (let j = i + 1; j < segs.length; j++) {
    const a = segs[i],
      b = segs[j];
    if (a.n === b.n || a.h !== b.h || a.at !== b.at) continue;
    if (Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo) > 0) {
      overlaps++;
      bad.push(
        "두 줄이 한 토막을 같이 지난다 (" +
          (a.h ? "y" : "x") +
          "=" +
          a.at +
          "): " +
          lines[a.n].name +
          " | " +
          lines[b.n].name,
      );
    }
  }

console.log(
  "상자 " +
    NODES.length +
    " · 줄 " +
    lines.length +
    " · 표시 " +
    EDGES.filter((e) => e.badge).length +
    " · 꺾인 점 겹침 " +
    bends +
    " · 줄 겹침 " +
    overlaps +
    " · " +
    (bad.length ? "걸린 것 " + bad.length : "깨끗함"),
);
bad.forEach((b) => console.log("  " + b));
process.exit(bad.length ? 1 : 0);
