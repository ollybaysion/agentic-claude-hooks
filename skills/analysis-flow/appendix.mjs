#!/usr/bin/env node
// analysis-flow 부록 — 단계 표(마크다운 · JSON) → 쿼리 · 명령 전문 HTML 조각. 의존 0, script 0, 외부 요청 0, 인라인 색 0.
//
//   node appendix.mjs <단계표.md|단계표.json>                 HTML 조각(<style> + <section>)을 stdout 으로
//   node appendix.mjs <단계표.md|단계표.json> <미리보기.html>  svg-diagram 미리보기에 넣는다: <style> 은 </head> 앞, <section> 은 </body> 앞(다시 돌리면 바꿔 넣는다)
//
// 단계 표의 칸: 번호 · 이름 · 출처 · 쿼리 또는 명령 · 조건 · 얻은 것 · 다음.
//   마크다운: 첫 표를 읽는다. 쿼리의 줄마다 `코드`, 줄 사이는 <br>, 글 안의 | 는 \| 로 적는다.
//   JSON: 같은 칸 이름을 키로 쓰는 객체의 배열. 쿼리의 줄 사이는 \n.
// 색 · 글꼴은 svg-diagram 스타일의 토큰(--fg · --muted · --line · --box · --font-mono · --fs-v)을 쓴다.
import { readFileSync, writeFileSync } from "node:fs";

const COLS = [
  "번호",
  "이름",
  "출처",
  "쿼리 또는 명령",
  "조건",
  "얻은 것",
  "다음",
];
const START = "<!-- analysis-flow appendix -->";
const END = "<!-- /analysis-flow appendix -->";

const die = (m) => {
  console.error(m);
  process.exit(1);
};
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const unwrap = (s) => {
  const t = s.trim();
  return t.length > 1 && t.startsWith("`") && t.endsWith("`")
    ? t.slice(1, -1)
    : t;
};
const empty = (s) => !s || /^[-—–\s]*$/.test(s);

// 마크다운 표 한 줄 → 칸들. \| 는 칸 구분이 아니다
const cells = (line) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

function fromMarkdown(text) {
  const lines = text.split("\n");
  const at = lines.findIndex(
    (l, i) =>
      l.trim().startsWith("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? ""),
  );
  if (at < 0) die("마크다운에서 표를 찾지 못했다(머리 줄 + | --- | 줄).");
  const head = cells(lines[at]);
  const missing = COLS.filter((c) => !head.includes(c));
  if (missing.length) die(`표 머리에 칸이 없다: ${missing.join(", ")}`);
  const rows = [];
  for (const l of lines.slice(at + 2)) {
    if (!l.trim().startsWith("|")) break;
    const c = cells(l);
    const row = Object.fromEntries(head.map((h, i) => [h, c[i] ?? ""]));
    row["쿼리 또는 명령"] = row["쿼리 또는 명령"]
      .split(/<br\s*\/?>/i)
      .map(unwrap)
      .join("\n");
    for (const k of COLS.filter((k) => k !== "쿼리 또는 명령"))
      row[k] = row[k]
        .split(/<br\s*\/?>/i)
        .map(unwrap)
        .join(" ");
    rows.push(row);
  }
  return rows;
}

function fromJson(text) {
  const rows = JSON.parse(text);
  if (!Array.isArray(rows)) die("JSON 은 단계 객체의 배열이어야 한다.");
  return rows.map((r) =>
    Object.fromEntries(COLS.map((k) => [k, String(r[k] ?? "")])),
  );
}

const CSS = `.af-appendix { max-width: 1240px; margin-top: 40px; border-top: 1px solid var(--line); padding-top: 8px; }
.af-appendix h2 { font-size: calc(var(--fs-v) * 1.25); margin: 16px 0 8px; }
.af-step { padding: 14px 0; border-bottom: 1px solid var(--line); }
.af-step h3 { font-size: var(--fs-v); margin: 0 0 6px; }
.af-step dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 0; font-size: calc(var(--fs-v) * 0.95); }
.af-step dt { color: var(--muted); }
.af-step dd { margin: 0; }
.af-step pre { margin: 10px 0 0; padding: 10px 12px; background: var(--box); border: 1px solid var(--line); border-radius: 6px; overflow-x: auto; }
.af-step code { font-family: var(--font-mono); font-size: calc(var(--fs-v) * 0.92); }`;

const wrap = (body) => `${START}\n${body}\n${END}`;
const styleEl = () => `<style>\n${CSS}\n</style>`;

function section(rows) {
  const sorted = [...rows].sort(
    (a, b) => parseFloat(a["번호"]) - parseFloat(b["번호"]),
  );
  const step = (r) => {
    const dl = ["출처", "조건", "얻은 것"]
      .filter((k) => !empty(r[k]))
      .map((k) => `<dt>${k}</dt><dd>${esc(r[k])}</dd>`)
      .join("");
    const q = r["쿼리 또는 명령"];
    return `<div class="af-step" id="af-step-${esc(r["번호"])}">
<h3>${esc(r["번호"])}. ${esc(r["이름"])}</h3>
<dl>${dl}</dl>${empty(q) ? "" : `\n<pre><code>${esc(q)}</code></pre>`}
</div>`;
  };
  return `<section class="af-appendix" aria-labelledby="af-appendix-h">
<h2 id="af-appendix-h">부록 — 단계별 쿼리 · 명령 전문</h2>
${sorted.map(step).join("\n")}
</section>`;
}

// 앞서 넣은 조각(START … END)을 전부 걷는다 — 다시 돌려도 한 벌만 남는다
const strip = (page) => {
  for (;;) {
    const s = page.indexOf(START),
      e = page.indexOf(END, s);
    if (s < 0 || e < 0) return page;
    page = page.slice(0, s).replace(/\n$/, "") + page.slice(e + END.length);
  }
};

const [src, html] = process.argv.slice(2);
if (!src) die("node appendix.mjs <단계표.md|단계표.json> [미리보기.html]");
let text;
try {
  text = readFileSync(src, "utf8");
} catch (e) {
  die(`단계 표를 읽지 못했다: ${e.message}`);
}
const rows = src.endsWith(".json") ? fromJson(text) : fromMarkdown(text);
if (!rows.length) die("단계가 하나도 없다.");

if (!html) {
  process.stdout.write(`${styleEl()}\n${section(rows)}\n`);
} else {
  let page;
  try {
    page = strip(readFileSync(html, "utf8"));
  } catch (e) {
    die(`미리보기를 읽지 못했다: ${e.message}`);
  }
  if (!page.includes("</head>") || !page.includes("</body>"))
    die("미리보기에 </head> · </body> 가 없다.");
  page = page
    .replace("</head>", `${wrap(styleEl())}\n</head>`)
    .replace("</body>", `${wrap(section(rows))}\n</body>`);
  writeFileSync(html, page);
  console.error(`부록 ${html} — 단계 ${rows.length}개`);
}
