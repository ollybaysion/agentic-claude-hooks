#!/usr/bin/env node
// html-doc v4 검사기(check.mjs) 테스트.
// Run: node skills/html-doc/test.mjs
//
// 오프라인 테스트다. 통과하는 최소 문서를 규칙마다 하나씩 망가뜨려 checkHtml 을 본다.
// 끝으로 template.html(자리표시를 채우면) · examples/showcase.html · patterns/*.html 이 통과하는지 본다.
// 시안 모드(--mockup)는 통과하는 시안 문서를 규칙마다 망가뜨리고, 시안 견본 · 완성 예를 본다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHtml } from "./check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const HEAD = `<header>
<nav class="coord" aria-label="문서 좌표"><span>대분류</span> › <span aria-current="page">이 문서</span></nav>
<h1 id="top">제목</h1>
<p class="sub">부제</p>
<p class="meta"><span>2026-11-08</span></p>
</header>`;

function validDoc({ derived = false, head = HEAD } = {}) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>테스트 문서</title>
<style>
:root { --bg: #fff; --ink: #111; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #000; --ink: #eee; } }
:root[data-theme="dark"] { --bg: #000; --ink: #eee; }
:root[data-theme="light"] { color-scheme: light; }
body { font-size: 17px; }
h1 { font-size: 72px; }
@media (max-width: 760px) { h1 { font-size: 40px; } }
@media print { .toc { display: none; } }
.icon { background: url(data:image/svg+xml,%3Csvg%3E%3C/svg%3E); }
.grad { fill: url(#gradient); }
.toc-list a[href="#s9"] { color: var(--ink); }
</style>
</head>
<body>
${head}
<nav class="toc" aria-label="차례"><ol><li><a href="#s1">본문</a></li></ol></nav>
<main>
<section id="s1">
<h2>본문</h2>
<p><a href="https://github.com/example">바깥 이동 링크는 통과</a></p>
<img src="data:image/gif;base64,R0lGOD" alt="inline">
</section>
</main>
${derived ? '<footer class="derived" data-derived-from="docs/src.md">파생물</footer>' : ""}
</body>
</html>`;
}

const rules = (html, opts) => checkHtml(html, opts).errors.map((e) => e.rule);
const warns = (html) => checkHtml(html).warnings.map((w) => w.rule);

test("통과 예: 최소 문서 · --derived 문서", () => {
  assert.deepEqual(rules(validDoc()), []);
  assert.deepEqual(warns(validDoc()), []);
  assert.deepEqual(rules(validDoc({ derived: true }), { derived: true }), []);
});

test("골격: doctype · html lang · title", () => {
  assert.ok(rules(validDoc().replace("<!DOCTYPE html>", "")).includes("doctype"));
  assert.ok(rules(validDoc().replace(' lang="ko"', "")).includes("html-lang"));
  assert.ok(rules(validDoc().replace("테스트 문서", " ")).includes("title"));
});

test("머리: 넷이 다 있어야 한다", () => {
  for (const cut of [/<nav class="coord"[\s\S]*?<\/nav>/, /<p class="sub">.*?<\/p>/, /<p class="meta">.*?<\/p>/]) {
    assert.ok(rules(validDoc({ head: HEAD.replace(cut, "") })).includes("head"), String(cut));
  }
  assert.ok(rules(validDoc({ head: HEAD.replace(/<h1[\s\S]*?<\/h1>/, "") })).includes("head"));
});

test("머리: 순서가 틀리면 head-order", () => {
  const subFirst = HEAD.replace('<p class="sub">부제</p>\n', "").replace("<h1", '<p class="sub">부제</p>\n<h1');
  assert.ok(rules(validDoc({ head: subFirst })).includes("head-order"));
  const coordLast = HEAD.replace(/(<nav class="coord"[\s\S]*?<\/nav>)\n([\s\S]*?)<\/header>/, "$2$1</header>");
  assert.ok(rules(validDoc({ head: coordLast })).includes("head-order"));
});

test("머리: h1 은 하나", () => {
  const two = validDoc().replace("<h2>본문</h2>", "<h1>둘째 제목</h1>");
  assert.ok(rules(two).includes("head"));
});

test("차례: nav.toc 와 #링크", () => {
  const noToc = validDoc().replace(/<nav class="toc"[\s\S]*?<\/nav>/, "");
  assert.ok(rules(noToc).includes("toc"));
  const broken = validDoc().replace('<a href="#s1">본문</a>', '<a href="#nope">없는 절</a>');
  assert.ok(rules(broken).includes("anchor"));
});

test("앵커 · id: CSS 선택자 속 #링크는 보지 않고, id 겹침은 막는다", () => {
  // validDoc 의 <style> 에 a[href="#s9"] 가 있다 — 마크업이 아니라 통과
  assert.ok(!rules(validDoc()).includes("anchor"));
  const dup = validDoc().replace("<h2>본문</h2>", '<h2 id="s1">본문</h2>');
  assert.ok(rules(dup).includes("dup-id"));
});

test("점선: dashed · dotted · stroke-dasharray 는 막고 none 은 통과", () => {
  const border = validDoc().replace(".grad {", ".x { border: 1px dashed var(--ink); } .grad {");
  assert.ok(rules(border).includes("no-dash"));
  const dotted = validDoc().replace(".grad {", ".x { outline: 1px dotted var(--ink); } .grad {");
  assert.ok(rules(dotted).includes("no-dash"));
  const dash = validDoc().replace(".grad {", ".d .edge { stroke-dasharray: 6 4; } .grad {");
  assert.ok(rules(dash).includes("no-dash"));
  const attr = validDoc().replace("</main>", '<svg><path d="M0 0" stroke-dasharray="4"/></svg></main>');
  assert.ok(rules(attr).includes("no-dash"));
  const none = validDoc().replace(".grad {", ".d .edge { stroke-dasharray: none; } .grad {");
  assert.ok(!rules(none).includes("no-dash"));
  // 주석 · 본문 글의 낱말은 CSS 가 아니다
  const prose = validDoc().replace("<h2>본문</h2>", "<h2>dashed 는 쓰지 않는다</h2>").replace(".grad {", "/* dotted */ .grad {");
  assert.ok(!rules(prose).includes("no-dash"));
});

test("자기완결: 외부 src · 로컬 파일 · CSS @import · url()", () => {
  const cdn = validDoc().replace("</main>", '<img src="https://cdn.example.com/x.png" alt=""></main>');
  assert.ok(rules(cdn).includes("external-resource"));
  const local = validDoc().replace("</main>", '<img src="./shot.png" alt=""></main>');
  assert.ok(rules(local).includes("external-resource"));
  const sheet = validDoc().replace("</head>", '<link rel="stylesheet" href="style.css"></head>');
  assert.ok(rules(sheet).includes("external-resource"));
  const imp = validDoc().replace(":root {", '@import "x.css"; :root {');
  assert.ok(rules(imp).includes("css-import"));
  const url = validDoc().replace("url(#gradient)", "url(https://fonts.example.com/x.woff2)");
  assert.ok(rules(url).includes("css-url"));
  const use = validDoc().replace("</main>", '<svg><use href="#icon"></use></svg><span id="icon"></span></main>');
  assert.deepEqual(rules(use), []);
});

test("script 0: <script> 는 막고 이스케이프한 예시는 통과", () => {
  const src = validDoc().replace("</main>", '<script src="https://cdn.example.com/x.js"></script></main>');
  assert.ok(rules(src).includes("no-script"));
  assert.ok(rules(src).includes("external-resource"));
  const inline = validDoc().replace("</main>", "<script>var x = 1;</script></main>");
  assert.ok(rules(inline).includes("no-script"));
  const escaped = validDoc().replace("</main>", "<pre><code>&lt;script&gt;&lt;/script&gt;</code></pre></main>");
  assert.ok(!rules(escaped).includes("no-script"));
});

test("테마: media · data-theme 둘 다, 다크 토큰은 두 자리에 같은 이름", () => {
  assert.ok(rules(validDoc().replace("prefers-color-scheme: dark", "x")).includes("theme-media"));
  assert.ok(rules(validDoc().replaceAll('[data-theme="light"]', "[data-x]")).includes("theme-override"));
  const onlyMedia = validDoc().replace(':root[data-theme="dark"] { --bg: #000; --ink: #eee; }', ':root[data-theme="dark"] { color-scheme: dark; }');
  assert.ok(rules(onlyMedia).includes("theme-dark-tokens"));
  const differ = validDoc().replace(':root[data-theme="dark"] { --bg: #000; --ink: #eee; }', ':root[data-theme="dark"] { --bg: #000; }');
  assert.ok(rules(differ).includes("theme-dark-tokens"));
});

test("인쇄 CSS", () => {
  assert.ok(rules(validDoc().replace("@media print", "@media screen")).includes("print-css"));
});

test("글자 비: 제목 ÷ 본문 < 4 는 오류, 못 읽으면 경고", () => {
  const small = validDoc().replace("h1 { font-size: 72px; }", "h1 { font-size: 40px; }");
  assert.ok(rules(small).includes("type-ratio"));
  const rem = validDoc().replace("h1 { font-size: 72px; }", "h1 { font-size: 4.5rem; }");
  assert.ok(!rules(rem).includes("type-ratio"));
  const clamp = validDoc().replace("h1 { font-size: 72px; }", "h1 { font-size: clamp(40px, 8vw, 72px); }");
  assert.ok(!rules(clamp).includes("type-ratio"));
  assert.deepEqual(warns(clamp), ["type-ratio"]);
});

test("section id · table-scroll · 인라인 색 · 자리표시 · 파생물", () => {
  assert.ok(rules(validDoc().replace("</main>", "<section><h2>무제</h2></section></main>")).includes("section-id"));
  assert.ok(rules(validDoc().replace("</main>", "<table><tr><td>x</td></tr></table></main>")).includes("table-scroll"));
  assert.ok(!rules(validDoc().replace("</main>", '<div class="table-scroll"><table><tr><td>x</td></tr></table></div></main>')).includes("table-scroll"));
  assert.ok(rules(validDoc().replace("</main>", '<p style="color:#c00">x</p></main>')).includes("inline-color"));
  assert.ok(rules(validDoc().replace("</main>", '<svg><rect fill="#fff"/></svg></main>')).includes("inline-color"));
  assert.ok(rules(validDoc().replace("<h2>본문</h2>", "<h2>{{절 제목}}</h2>")).includes("placeholder"));
  assert.ok(!rules(validDoc().replace("</main>", "<pre><code>{{ vue }}</code></pre></main>")).includes("placeholder"));
  assert.ok(rules(validDoc(), { derived: true }).includes("derived-footer"));
});

test("HTML 주석은 검사 전에 걷는다", () => {
  const hidden = validDoc().replace("</main>", '<!-- <script src="https://x"></script> --></main>');
  assert.deepEqual(rules(hidden), []);
});

test("template.html: 자리표시만 채우면 통과, 원본은 자리표시로만 실패", () => {
  const raw = readFileSync(join(HERE, "template.html"), "utf8");
  const filled = raw.replace(/\{\{[^}]*\}\}/g, "채움");
  assert.deepEqual(checkHtml(filled).errors, []);
  assert.deepEqual(checkHtml(filled).warnings, []);
  assert.deepEqual([...new Set(rules(raw))], ["placeholder"]);
});

test("examples/showcase.html: 완성 예가 통과한다", () => {
  const { errors, warnings } = checkHtml(readFileSync(join(HERE, "examples", "showcase.html"), "utf8"));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});

test("patterns/*.html: 패턴 견본이 모두 통과한다", () => {
  const files = readdirSync(join(HERE, "patterns")).filter((f) => f.endsWith(".html"));
  assert.ok(files.length >= 3, "패턴 견본이 사라졌다");
  for (const f of files) {
    assert.deepEqual(checkHtml(readFileSync(join(HERE, "patterns", f), "utf8")).errors, [], f);
  }
});

// ───── 시안 모드(--mockup) ─────

const MOCK_CSS = `
:root { --a-canvas: #f4f5f7; --a-ink: #1c1f24; }
.scr { container-type: inline-size; aspect-ratio: 1440 / 900; }
.scr .v { position: absolute; width: 1440px; height: 900px; transform: scale(tan(atan2(100cqw, 1440px))); }
`;
const scene = (id) =>
  `<figure class="shot" id="${id}"><div class="scr" id="${id}-z"><div class="v"><div class="app" style="background: var(--a-canvas)">화면</div></div>` +
  `<a class="zopen" href="#${id}-z" aria-label="100% 로 보기"></a><a class="zclose" href="#${id}">닫기</a></div><figcaption>장면</figcaption></figure>`;
const opt = (no, { ref = `<p class="ref"><a href="https://example.com/x">제품</a> — 한 줄</p>`, scenes = 2 } = {}) =>
  `<section class="opt" id="o${no}"><div class="opt-head"><span class="opt-no">${no}</span><h2>안 ${no}</h2>${ref}</div>` +
  `<div class="shots">${Array.from({ length: scenes }, (_, i) => scene(`o${no}-s${i + 1}`)).join("")}</div></section>`;

function validMockup({ n = 8, axis = '<p class="axis" data-axis-from="user">축 한 줄</p>', opts, cmp = true } = {}) {
  const body = (opts ?? Array.from({ length: n }, (_, i) => opt(i + 1)).join("\n")) +
    (cmp ? '\n<section id="s2"><h2>비교표</h2><div class="table-scroll"><table class="cmp"><tr><td>1</td></tr></table></div></section>' : "");
  return validDoc({ head: HEAD.replace("</header>", `${axis}\n</header>`) })
    .replace("</style>", `${MOCK_CSS}</style>`)
    .replace("</main>", `${body}\n</main>`);
}
const mrules = (html, opts = {}) => rules(html, { mockup: true, ...opts });

test("시안 통과 예: 안 8 · 장면 2 · 비교표 · 앱 토큰, --mockup 이 없으면 시안 검사는 돌지 않는다", () => {
  assert.deepEqual(mrules(validMockup()), []);
  assert.deepEqual(rules(validDoc()), []);
  assert.deepEqual(mrules(validMockup({ n: 1 }), { minOpts: 1 }), []);
});

test("시안: 축 줄과 축의 출처", () => {
  assert.ok(mrules(validMockup({ axis: "" })).includes("mockup-axis"));
  assert.ok(mrules(validMockup({ axis: '<p class="axis">축</p>' })).includes("mockup-axis"));
  assert.ok(!mrules(validMockup({ axis: '<p class="axis" data-axis-from="author">축</p>' })).includes("mockup-axis"));
});

test("시안: 안 수 하한(기본 8, --min-opts)", () => {
  assert.ok(mrules(validMockup({ n: 7 })).includes("mockup-opts"));
  assert.ok(!mrules(validMockup({ n: 7 }), { minOpts: 7 }).includes("mockup-opts"));
});

test("시안: 안마다 레퍼런스 줄 — 링크가 있거나 직접 지은 안", () => {
  const rest = Array.from({ length: 7 }, (_, i) => opt(i + 2)).join("");
  assert.ok(mrules(validMockup({ opts: opt(1, { ref: "" }) + rest })).includes("mockup-ref"));
  assert.ok(mrules(validMockup({ opts: opt(1, { ref: '<p class="ref">제품 이름만</p>' }) + rest })).includes("mockup-ref"));
  assert.ok(!mrules(validMockup({ opts: opt(1, { ref: '<p class="ref own">직접 지은 안</p>' }) + rest })).includes("mockup-ref"));
});

test("시안: 안마다 장면 수가 같다 · 비교표가 있다", () => {
  const rest = Array.from({ length: 7 }, (_, i) => opt(i + 2)).join("");
  assert.ok(mrules(validMockup({ opts: opt(1, { scenes: 3 }) + rest })).includes("mockup-scenes"));
  assert.ok(mrules(validMockup({ opts: opt(1, { scenes: 0 }) + rest })).includes("mockup-scenes"));
  assert.ok(mrules(validMockup({ cmp: false })).includes("mockup-compare"));
});

test("시안: 화면 틀 .v 는 px 크기, 100% 보기는 여는 · 닫는 링크", () => {
  const pct = validMockup().replace("width: 1440px; height: 900px;", "width: 100%; height: 100%;");
  assert.ok(mrules(pct).includes("mockup-frame"));
  const noClose = validMockup().replace('<a class="zclose" href="#o1-s1">닫기</a>', "");
  assert.ok(mrules(noClose).includes("mockup-zoom"));
  const noOpen = validMockup().replace('<a class="zopen" href="#o1-s1-z" aria-label="100% 로 보기"></a>', "");
  assert.ok(mrules(noOpen).includes("mockup-zoom"));
});

test("시안: 앱 토큰은 라이트 고정, 화면 틀 안 인라인 style 은 --a-… 만", () => {
  const dark = validMockup().replace(':root[data-theme="dark"] { --bg: #000; --ink: #eee; }', ':root[data-theme="dark"] { --bg: #000; --ink: #eee; --a-canvas: #111; }');
  assert.ok(mrules(dark).includes("mockup-app-tokens"));
  const pageTok = validMockup().replace('style="background: var(--a-canvas)"', 'style="background: var(--ink)"');
  assert.ok(mrules(pageTok).includes("mockup-app-tokens"));
  const noTok = validMockup().replace(":root { --a-canvas: #f4f5f7; --a-ink: #1c1f24; }", "");
  assert.ok(mrules(noTok).includes("mockup-app-tokens"));
});

test("patterns/mockup.html · examples/mockup.html: 시안 견본(안 3)과 완성 예(안 8)가 --mockup 을 통과한다", () => {
  const pattern = readFileSync(join(HERE, "patterns", "mockup.html"), "utf8");
  assert.deepEqual(checkHtml(pattern, { mockup: true, minOpts: 3 }).errors, []);
  const { errors, warnings } = checkHtml(readFileSync(join(HERE, "examples", "mockup.html"), "utf8"), { mockup: true });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
});
