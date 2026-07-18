#!/usr/bin/env node
// Regression tests for the html-doc output checker (check.mjs).
// Run: node skills/html-doc/test.mjs
//
// Pure offline tests — 픽스처 문자열을 규칙별로 변형해 checkHtml을 검증하고,
// 마지막으로 template.html 자체가(플레이스홀더를 채우면) 철칙을 통과하는지 본다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHtml } from "./check.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function validDoc({ derived = false } = {}) {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>테스트 문서</title>
<style>
:root { --bg: #fff; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #000; } }
:root[data-theme="dark"] { --bg: #000; }
:root[data-theme="light"] { --bg: #fff; }
@media print { nav { display: none; } }
.icon { background: url(data:image/svg+xml,%3Csvg%3E%3C/svg%3E); }
.grad { fill: url(#gradient); }
</style>
</head>
<body>
<main>
<h2 id="intro">개요</h2>
<p><a href="https://github.com/example">외부 내비게이션 링크는 허용</a></p>
<h3 id="detail">상세</h3>
<img src="data:image/gif;base64,R0lGOD" alt="inline">
</main>
${derived ? '<footer class="derived" data-derived-from="docs/src.md">파생물</footer>' : ""}
</body>
</html>`;
}

function rules(html, opts) {
  return checkHtml(html, opts).errors.map((e) => e.rule);
}

test("valid doc passes; derived doc passes with --derived", () => {
  assert.deepEqual(rules(validDoc()), []);
  assert.deepEqual(rules(validDoc({ derived: true }), { derived: true }), []);
});

test("골격: doctype / html lang / title", () => {
  assert.ok(rules(validDoc().replace("<!DOCTYPE html>", "")).includes("doctype"));
  assert.ok(rules(validDoc().replace(' lang="ko"', "")).includes("html-lang"));
  assert.ok(rules(validDoc().replace("테스트 문서", " ")).includes("title"));
  assert.ok(rules(validDoc().replace(/<title>[\s\S]*?<\/title>/, "")).includes("title"));
});

test("self-contained: 리소스 태그의 외부/로컬 참조는 전부 거부", () => {
  const cdn = validDoc().replace(
    "</main>", '<script src="https://cdn.example.com/x.js"></script></main>');
  assert.ok(rules(cdn).includes("external-resource"));

  const localImg = validDoc().replace("</main>", '<img src="./shot.png" alt=""></main>');
  assert.ok(rules(localImg).includes("external-resource"));

  const sheet = validDoc().replace(
    "</head>", '<link rel="stylesheet" href="style.css"></head>');
  assert.ok(rules(sheet).includes("external-resource"));

  const proto = validDoc().replace(
    "</main>", '<iframe src="//example.com/embed"></iframe></main>');
  assert.ok(rules(proto).includes("external-resource"));
});

test("self-contained: data:/# 값과 <a href>는 허용", () => {
  // validDoc 자체가 data: img, url(data:), url(#), <a https://> 를 포함한다
  assert.deepEqual(rules(validDoc()), []);
  const useTag = validDoc().replace(
    "</main>", '<svg><use href="#icon"></use></svg></main>');
  assert.deepEqual(rules(useTag), []);
});

test("self-contained: CSS @import와 외부 url()", () => {
  const imp = validDoc().replace(":root {", '@import "extra.css"; :root {');
  assert.ok(rules(imp).includes("css-import"));
  const url = validDoc().replace(
    "url(#gradient)", "url(https://fonts.example.com/x.woff2)");
  assert.ok(rules(url).includes("css-url"));
  const localUrl = validDoc().replace("url(#gradient)", "url('./bg.png')");
  assert.ok(rules(localUrl).includes("css-url"));
});

test("테마: media query와 data-theme 양방향 오버라이드", () => {
  const noMedia = validDoc().replace("prefers-color-scheme: dark", "x");
  assert.ok(rules(noMedia).includes("theme-media"));
  const noLight = validDoc().replaceAll('[data-theme="light"]', "[data-x]");
  assert.ok(rules(noLight).includes("theme-override"));
  const noDark = validDoc().replaceAll('[data-theme="dark"]', "[data-x]");
  assert.ok(rules(noDark).includes("theme-override"));
});

test("인쇄 CSS", () => {
  assert.ok(rules(validDoc().replace("@media print", "@media screen"))
    .includes("print-css"));
});

test("h2/h3 id 강제", () => {
  const noId = validDoc().replace('<h3 id="detail">상세</h3>', "<h3>상세</h3>");
  const found = checkHtml(noId).errors.filter((e) => e.rule === "heading-id");
  assert.equal(found.length, 1);
  assert.match(found[0].msg, /상세/);
});

test("{{...}} 플레이스홀더 잔재", () => {
  const left = validDoc().replace("개요", "{{제목}}");
  assert.ok(rules(left).includes("placeholder"));
});

test("--derived: data-derived-from 표기 강제", () => {
  assert.ok(rules(validDoc(), { derived: true }).includes("derived-footer"));
});

test("규칙 '언급'은 무해하다 — 산문·코드 예시의 @import/url()/{{ }}", () => {
  // 메타 문서·Vue/Jinja류 예시가 오탐나면 안 된다
  const mention = validDoc().replace(
    "</main>",
    `<p>CSS에서 <code>@import</code>와 url(https://fonts.example.com/x.woff2)는 금지다.</p>
     <pre><code>&lt;p&gt;{{ user.name }}&lt;/p&gt;</code></pre>
     <p>플레이스홀더 표기는 <code>{{...}}</code>를 쓴다.</p></main>`);
  assert.deepEqual(rules(mention), []);
  // 실제 CSS 문맥에서는 여전히 걸린다: style 속성
  const attr = validDoc().replace(
    "</main>", '<div style="background:url(https://cdn.example.com/bg.png)"></div></main>');
  assert.ok(rules(attr).includes("css-url"));
});

test("inline-color: 인라인 style의 색 리터럴은 거부, 토큰·구조 값은 허용", () => {
  const hex = validDoc().replace(
    "</main>", '<p style="color:#333">강조</p></main>');
  assert.ok(rules(hex).includes("inline-color"));
  const rgb = validDoc().replace(
    "</main>", '<td style="background: rgb(255, 0, 0)">셀</td></main>');
  assert.ok(rules(rgb).includes("inline-color"));
  // 토큰 참조·구조 값(폭 등)은 일관성을 깨지 않는다
  const ok = validDoc().replace(
    "</main>",
    '<p style="background: var(--surface)">면</p><div style="width:40%"></div></main>');
  assert.deepEqual(rules(ok), []);
  // <style> 블록의 hex는 토큰 정의처 — 검사 대상 아님 (validDoc 자체가 증명)
  assert.deepEqual(rules(validDoc()), []);
});

test("HTML 주석은 검사 전에 제거된다 — 양방향", () => {
  // 주석 안의 위반은 무시된다
  const bad = validDoc().replace(
    "</main>", '<!-- <img src="https://cdn.example.com/x.png"> --></main>');
  assert.deepEqual(rules(bad), []);
  // 주석 안의 표기는 요건을 충족하지 못한다
  const fake = validDoc().replace(
    "</main>", '<!-- <footer data-derived-from="x.md"></footer> --></main>');
  assert.ok(rules(fake, { derived: true }).includes("derived-footer"));
});

test("patterns/*.html: 모든 패턴 견본이 철칙을 통과한다 (골든)", () => {
  const files = readdirSync(join(HERE, "patterns")).filter((f) => f.endsWith(".html"));
  assert.ok(files.length >= 6, "패턴 견본이 사라졌다");
  for (const f of files) {
    const { errors } = checkHtml(readFileSync(join(HERE, "patterns", f), "utf8"));
    assert.deepEqual(errors, [], `${f}가 철칙을 어긴다`);
  }
});

test("template.html: 플레이스홀더만 채우면 철칙을 통과한다", () => {
  const raw = readFileSync(join(HERE, "template.html"), "utf8");
  const filled = raw.replace(/\{\{[^}]*\}\}/g, "채움");
  const { ok, errors } = checkHtml(filled);
  assert.deepEqual(errors, [], "template.html이 자기 철칙을 어긴다");
  assert.ok(ok);
  // 템플릿 원본은 플레이스홀더 잔재로만 실패해야 한다
  assert.deepEqual([...new Set(rules(raw))], ["placeholder"]);
});
