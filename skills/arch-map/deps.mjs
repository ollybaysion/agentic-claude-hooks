#!/usr/bin/env node
// 소스 뿌리 아래의 첫 폴더(단위)끼리 누가 누구를 import 하는지 센다. 지도의 상자와 호출 후보를 뽑을 때 쓴다.
//
//   node deps.mjs <소스 뿌리> [--depth 1] [--alias @/=.] [--json]
//
//   소스 뿌리   Java · Kotlin 은 패키지 뿌리(src/main/java/com/acme/app), TS · JS 는 src, Python 은 패키지 폴더
//   --depth N   단위를 뿌리 아래 N 단 폴더로 잡는다 (기본 1)
//   --alias     TS · JS 의 경로 별칭. '@/=.' 는 '@/x' 를 뿌리 아래 x 로 읽는다. 여러 번 쓸 수 있다
//
// import 는 "기댄다" 는 사실만 말한다. 지도의 줄(호출)은 이 표에서 후보를 뽑아 코드에서 확인한 뒤 긋는다.
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const root = argv.find(
  (a, i) =>
    !a.startsWith("--") && !["--depth", "--alias"].includes(argv[i - 1]),
);
if (!root) {
  console.error(
    "쓰기: node deps.mjs <소스 뿌리> [--depth 1] [--alias @/=.] [--json]",
  );
  process.exit(1);
}
const depth = +(argv[argv.indexOf("--depth") + 1] && argv.includes("--depth")
  ? argv[argv.indexOf("--depth") + 1]
  : 1);
const aliases = argv.flatMap((a, i) =>
  a === "--alias" ? [argv[i + 1].split("=")] : [],
);
const EXT = {
  ".java": "jvm",
  ".kt": "jvm",
  ".ts": "js",
  ".tsx": "js",
  ".js": "js",
  ".jsx": "js",
  ".mjs": "js",
  ".py": "py",
};
const SKIP = new Set([
  "node_modules",
  ".git",
  "build",
  "dist",
  "out",
  "target",
  "__pycache__",
  ".next",
  ".venv",
  "venv",
]);

const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (EXT[path.extname(e.name)]) files.push(p);
  }
})(root);
if (!files.length) {
  console.error("소스 파일이 없다: " + root);
  process.exit(1);
}

// 뿌리에서 본 경로 → 단위 이름. 뿌리 바로 아래 파일은 '(뿌리)' 다.
const unitOf = (rel) => {
  const parts = rel.split(path.sep);
  return parts.length <= depth
    ? parts.length === 1
      ? "(뿌리)"
      : parts.slice(0, -1).join("/")
    : parts.slice(0, depth).join("/");
};

// JVM: 파일의 package 줄에서 뿌리 패키지를 구한다
let base = null;
for (const f of files) {
  if (EXT[path.extname(f)] !== "jvm") continue;
  const m = /^\s*package\s+([\w.]+)/m.exec(fs.readFileSync(f, "utf8"));
  if (!m) continue;
  const dirs = path
    .relative(root, path.dirname(f))
    .split(path.sep)
    .filter(Boolean);
  const pk = m[1].split(".");
  base = pk.slice(0, pk.length - dirs.length).join(".");
  break;
}
const pyBase = path.basename(path.resolve(root));

const stat = {}; // 단위 → { files, lines }
const dep = {}; // 부르는 단위 → 불리는 단위 → { n: import 수, by: 파일 집합 }
const big = [];
const add = (from, to, file) => {
  if (!to || from === to) return;
  dep[from] = dep[from] || {};
  const d = (dep[from][to] = dep[from][to] || { n: 0, by: new Set() });
  d.n++;
  d.by.add(file);
};
const unitOfDotted = (parts) =>
  parts.length <= depth ? null : parts.slice(0, depth).join("/");
for (const f of files) {
  const rel = path.relative(root, f);
  const from = unitOf(rel);
  const text = fs.readFileSync(f, "utf8");
  const lines = text.split("\n").length;
  stat[from] = stat[from] || { files: 0, lines: 0 };
  stat[from].files++;
  stat[from].lines += lines;
  big.push([lines, rel]);
  const kind = EXT[path.extname(f)];
  if (kind === "jvm" && base !== null) {
    const re = /^\s*import\s+(?:static\s+)?([\w.]+)/gm;
    let m;
    while ((m = re.exec(text))) {
      if (!m[1].startsWith(base + ".")) continue;
      add(from, unitOfDotted(m[1].slice(base.length + 1).split(".")), rel);
    }
  } else if (kind === "js") {
    const re =
      /(?:from\s+|require\(\s*|import\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
    let m;
    while ((m = re.exec(text))) {
      let spec = m[1];
      let target = null;
      if (spec.startsWith("."))
        target = path.relative(root, path.resolve(path.dirname(f), spec));
      else {
        for (const [from0, to0] of aliases)
          if (spec.startsWith(from0))
            target = path.normalize(path.join(to0, spec.slice(from0.length)));
      }
      if (target === null || target.startsWith("..")) continue;
      const parts = target.split(path.sep).filter((p) => p && p !== ".");
      add(
        from,
        parts.length <= depth
          ? parts.length
            ? parts.slice(0, Math.min(depth, parts.length)).join("/")
            : null
          : parts.slice(0, depth).join("/"),
        rel,
      );
    }
  } else if (kind === "py") {
    const re = /^\s*(?:from\s+(\.*)([\w.]*)\s+import|import\s+([\w.]+))/gm;
    let m;
    while ((m = re.exec(text))) {
      let parts = null;
      if (m[1]) {
        const up = path
          .relative(root, path.dirname(f))
          .split(path.sep)
          .filter(Boolean);
        parts = up
          .slice(0, up.length - (m[1].length - 1))
          .concat(m[2] ? m[2].split(".") : []);
      } else {
        const dotted = (m[2] || m[3] || "").split(".");
        if (dotted[0] === pyBase) parts = dotted.slice(1);
      }
      if (parts && parts.length)
        add(from, parts.slice(0, depth).join("/"), rel);
    }
  }
}

const units = Object.keys(stat).sort((a, b) => stat[b].lines - stat[a].lines);
const pairs = [];
for (const a of units)
  for (const b of Object.keys(dep[a] || {}))
    pairs.push({
      from: a,
      to: b,
      imports: dep[a][b].n,
      files: dep[a][b].by.size,
    });
const mutual = pairs
  .filter((p) => p.from < p.to && dep[p.to] && dep[p.to][p.from])
  .map((p) => [p.from, p.to]);
big.sort((a, b) => b[0] - a[0]);

if (argv.includes("--json")) {
  console.log(
    JSON.stringify(
      {
        root,
        units: units.map((u) => ({ unit: u, ...stat[u] })),
        deps: pairs,
        mutual,
        biggest: big.slice(0, 10),
      },
      null,
      2,
    ),
  );
} else {
  const total = units.reduce((s, u) => s + stat[u].lines, 0);
  console.log(
    "단위 " +
      units.length +
      " · 파일 " +
      files.length +
      " · " +
      total +
      " 줄\n",
  );
  console.log("단위 (파일 · 줄) → 기대는 단위(import 수)");
  for (const u of units) {
    const outs = Object.keys(dep[u] || {})
      .sort((a, b) => dep[u][b].n - dep[u][a].n)
      .map((t) => t + "(" + dep[u][t].n + ")");
    console.log(
      "  " +
        u +
        " (" +
        stat[u].files +
        " · " +
        stat[u].lines +
        ") → " +
        (outs.join(" ") || "없음"),
    );
  }
  console.log(
    "\n서로 기대는 쌍 " +
      mutual.length +
      (mutual.length ? ": " + mutual.map((m) => m.join(" ↔ ")).join(", ") : ""),
  );
  console.log("\n큰 파일");
  for (const [n, f] of big.slice(0, 10)) console.log("  " + n + "  " + f);
}
