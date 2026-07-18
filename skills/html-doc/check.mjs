#!/usr/bin/env node
// html-doc 산출물 검증기 — 렌더된 HTML이 스킬의 철칙을 지키는지 정적 검사한다.
// Run: node skills/html-doc/check.mjs <file.html> [--derived]
//
// 검사 항목: self-contained(리소스 로드 0), 문서 골격(DOCTYPE/lang/title),
// 테마(prefers-color-scheme + data-theme 양방향 오버라이드), 인쇄 CSS,
// h2/h3 id, {{...}} 플레이스홀더 잔재, 인라인 style 색 리터럴(디자인 토큰
// 강제 — design.md), (--derived) 파생물 표기.
// 정적 검사의 한계: 인라인 JS의 런타임 네트워크 호출(fetch/XHR)은 못 잡는다.
//
// <a href="https://...">는 허용한다 — 내비게이션 링크는 리소스 로드가 아니다.
// 금지 대상은 "열 때 브라우저가 가져오는 것"(script/link/img/... 의 src·href,
// CSS @import·url())이며, 값은 data: 또는 #fragment 만 허용한다.

import { readFileSync } from "node:fs";

// 리소스를 로드하는 태그(내비게이션 태그 a/area는 제외)
const RESOURCE_TAGS =
  /<(script|link|img|iframe|audio|video|source|embed|object|track|use)\b[^>]*>/gi;
const ATTR_RE = /\b(src|href|srcset|poster|data)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;

function attrValueOk(value) {
  const v = value.trim();
  return v === "" || /^data:/i.test(v) || v.startsWith("#");
}

function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

// CSS가 실제로 해석되는 문맥만 모은다 — <style> 블록 + style="" 속성.
// 본문 산문/코드 예시에서 @import·url()을 "언급"하는 건 리소스를 안 가져온다.
function cssContexts(doc) {
  const parts = [];
  let m;
  const STYLE_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  while ((m = STYLE_RE.exec(doc)) !== null) parts.push(m[1]);
  const ATTR_STYLE_RE = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi;
  while ((m = ATTR_STYLE_RE.exec(doc)) !== null) parts.push(m[2] ?? m[3] ?? "");
  return parts.join("\n");
}

// 코드 예시(<pre>/<code>) 내용을 제거 — Vue/Jinja류 예시의 {{ }}는 잔재가 아니다.
function stripCodeBlocks(doc) {
  return doc
    .replace(/<pre\b[\s\S]*?<\/pre>/gi, "")
    .replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, "");
}

export function checkHtml(html, { derived = false } = {}) {
  const errors = [];
  const doc = stripComments(html);

  // 골격
  if (!/^\s*<!doctype html>/i.test(doc)) {
    errors.push({ rule: "doctype", msg: "<!DOCTYPE html>로 시작해야 한다" });
  }
  if (!/<html\b[^>]*\blang\s*=/i.test(doc)) {
    errors.push({ rule: "html-lang", msg: '<html lang="ko"> — lang 속성이 없다' });
  }
  const title = doc.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!title || !title[1].trim()) {
    errors.push({ rule: "title", msg: "<title>이 없거나 비어 있다" });
  }

  // self-contained: 리소스 태그의 src/href 등은 data: 또는 #만 허용
  for (const tag of doc.match(RESOURCE_TAGS) ?? []) {
    ATTR_RE.lastIndex = 0;
    let m;
    while ((m = ATTR_RE.exec(tag)) !== null) {
      const value = m[3] ?? m[4] ?? m[5] ?? "";
      if (!attrValueOk(value)) {
        errors.push({
          rule: "external-resource",
          msg: `리소스 참조 발견(외부 URL·로컬 파일 모두 금지, data:/#만 허용): ${tag.slice(0, 120)}`,
        });
      }
    }
  }

  // self-contained: CSS — @import는 무조건 금지, url()은 data:/#만 허용.
  // 검사 범위는 실제 CSS 문맥(<style>/style=)만 — 산문·코드 예시의 언급은 무해.
  const css = cssContexts(doc);
  if (/@import\b/i.test(css)) {
    errors.push({ rule: "css-import", msg: "@import는 리소스를 가져온다 — 금지" });
  }
  const URL_RE = /\burl\(\s*("([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi;
  let u;
  while ((u = URL_RE.exec(css)) !== null) {
    const value = (u[2] ?? u[3] ?? u[4] ?? "").trim();
    if (!attrValueOk(value)) {
      errors.push({ rule: "css-url", msg: `CSS url() 외부/로컬 참조: url(${value})` });
    }
  }

  // 디자인 토큰: 인라인 style의 색 리터럴은 다크 테마를 조용히 깬다 —
  // var(--...) 토큰만 허용 (design.md). <style> 블록은 토큰 정의처라 제외.
  const STYLE_ATTR_RE = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let sa;
  while ((sa = STYLE_ATTR_RE.exec(doc)) !== null) {
    const value = sa[2] ?? sa[3] ?? "";
    if (/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i.test(value)) {
      errors.push({
        rule: "inline-color",
        msg: `인라인 style의 색 리터럴(다크 테마 깨짐) — var(--...) 토큰을 쓴다: style="${value.slice(0, 60)}"`,
      });
    }
  }

  // 테마: OS 연동 + 수동 토글 오버라이드 양방향
  if (!/prefers-color-scheme:\s*dark/i.test(doc)) {
    errors.push({ rule: "theme-media", msg: "@media (prefers-color-scheme: dark)가 없다" });
  }
  if (!/\[data-theme="dark"\]/.test(doc) || !/\[data-theme="light"\]/.test(doc)) {
    errors.push({
      rule: "theme-override",
      msg: ':root[data-theme="dark"] / [data-theme="light"] 오버라이드가 둘 다 있어야 한다',
    });
  }

  // 인쇄
  if (!/@media\s+print\b/i.test(doc)) {
    errors.push({ rule: "print-css", msg: "@media print 블록이 없다" });
  }

  // h2/h3 id — TOC·앵커 안정성. id는 저작 시점에 부여한다(JS 생성 금지).
  const HEADING_RE = /<h([23])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
  let h;
  while ((h = HEADING_RE.exec(doc)) !== null) {
    if (!/\bid\s*=/i.test(h[2])) {
      const text = h[3].replace(/<[^>]*>/g, "").trim().slice(0, 40);
      errors.push({ rule: "heading-id", msg: `id 없는 h${h[1]}: "${text}"` });
    }
  }

  // 템플릿 플레이스홀더 잔재 — 코드 예시(<pre>/<code>) 속 {{ }}는 제외
  if (/\{\{/.test(stripCodeBlocks(doc))) {
    errors.push({ rule: "placeholder", msg: "{{...}} 플레이스홀더가 남아 있다" });
  }

  // 파생물 표기(md 변환 모드)
  if (derived && !/\bdata-derived-from\s*=/i.test(doc)) {
    errors.push({
      rule: "derived-footer",
      msg: '변환 산출물엔 <footer class="derived" data-derived-from="<소스 경로>">가 필요하다',
    });
  }

  return { ok: errors.length === 0, errors };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const derived = args.includes("--derived");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: node check.mjs <file.html> [--derived]");
    process.exit(1);
  }
  const { ok, errors } = checkHtml(readFileSync(file, "utf8"), { derived });
  if (ok) {
    console.log(`OK: ${file} — html-doc 철칙 통과${derived ? " (derived)" : ""}`);
  } else {
    console.error(`FAIL: ${file} — ${errors.length}건`);
    for (const e of errors) console.error(`  [${e.rule}] ${e.msg}`);
    process.exit(1);
  }
}
