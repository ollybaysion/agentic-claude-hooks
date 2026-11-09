#!/usr/bin/env node
// html-doc v3 산출물 검사기 — 만든 HTML 이 스킬의 철칙을 지키는지 정적으로 본다.
// Run: node skills/html-doc/check.mjs <file.html> [--derived]
//
// 오류(exit 1): 자기완결(리소스 로드 0) · 골격(DOCTYPE · lang · title) · 테마(다크 토큰 두 자리) ·
// 인쇄 CSS · script 0 · 머리 넷의 순서 · 차례 · 앵커 · id 겹침 · section id · 표의 .table-scroll ·
// 점선 0 · 인라인 색 · {{...}} 잔재 · 제목/본문 글자 비 4 이상 · (--derived) 파생물 표기.
// 경고(exit 0): 제목/본문 글자 크기를 정적 CSS 에서 읽지 못함.
//
// <a href="https://..."> 는 통과한다 — 이동 링크는 리소스 로드가 아니다.
// 막는 것은 "열 때 브라우저가 가져오는 것"(script/link/img/... 의 src·href, CSS @import·url())이고,
// 값은 data: 또는 #조각만 통과한다.

import { readFileSync } from "node:fs";

const RESOURCE_TAGS =
  /<(script|link|img|iframe|audio|video|source|embed|object|track|use|image)\b[^>]*>/gi;
const ATTR_RE = /\b(src|href|srcset|poster|data)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const TYPE_RATIO = 4;

const attrValueOk = (value) => {
  const v = value.trim();
  return v === "" || /^data:/i.test(v) || v.startsWith("#");
};
const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, "");
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// CSS 가 실제로 해석되는 자리만 모은다 — <style> 블록 + style="" 속성.
function cssContexts(doc) {
  const parts = [];
  let m;
  const STYLE_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  while ((m = STYLE_RE.exec(doc)) !== null) parts.push(stripCssComments(m[1]));
  const ATTR_STYLE_RE = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi;
  while ((m = ATTR_STYLE_RE.exec(doc)) !== null) parts.push(m[2] ?? m[3] ?? "");
  return parts.join("\n");
}

// 코드 예시(<pre>/<code>) 내용을 걷는다 — 예시 속 {{ }} 는 잔재가 아니다.
const stripCodeBlocks = (doc) =>
  doc.replace(/<pre\b[\s\S]*?<\/pre>/gi, "").replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, "");

// CSS 를 위에서부터 훑어 { prelude, body, depth0 } 블록으로 나눈다. @media 안 규칙은 inMedia 로 표시한다.
function cssRules(css) {
  const out = [];
  const walk = (src, at) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf("{", i);
      if (open < 0) break;
      const prelude = src.slice(i, open).replace(/^[\s;}]+/, "").trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
        j++;
      }
      const body = src.slice(open + 1, j - 1);
      if (prelude.startsWith("@")) walk(body, prelude);
      else out.push({ prelude, body, at });
      i = j;
    }
  };
  walk(css, null);
  return out;
}

const customProps = (body) =>
  new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

// 선택자 목록 중 하나가 그 요소(h1 · body) 자신을 고르나 — 마지막 조각이 그 이름으로 시작한다
const selects = (prelude, tag) =>
  prelude.split(",").some((s) => new RegExp(`^${tag}(?=$|[.:#\\[])`).test(s.trim().split(/[\\s>+~]+/).pop()));

// 머리 · 미디어 밖 규칙에서 마지막으로 정한 font-size(px). rem 은 16 px 로 본다. 못 읽으면 null.
function fontSizePx(rules, tag) {
  let size;
  for (const r of rules) {
    if (r.at || !selects(r.prelude, tag)) continue;
    const m = r.body.match(/font-size\s*:\s*([^;]+)/i);
    if (m) size = m[1].trim();
  }
  if (size === undefined) return null;
  const px = size.match(/^([\d.]+)px$/i);
  if (px) return Number(px[1]);
  const rem = size.match(/^([\d.]+)rem$/i);
  if (rem) return Number(rem[1]) * 16;
  return null;
}

export function checkHtml(html, { derived = false } = {}) {
  const errors = [];
  const warnings = [];
  const err = (rule, msg) => errors.push({ rule, msg });
  const doc = stripComments(html);
  const markup = doc.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ""); // id · 링크 · 머리는 마크업에서만 본다

  // 골격
  if (!/^\s*<!doctype html>/i.test(doc)) err("doctype", "<!DOCTYPE html> 로 시작해야 한다");
  if (!/<html\b[^>]*\blang\s*=/i.test(doc)) err("html-lang", '<html lang="ko"> — lang 속성이 없다');
  const title = doc.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!title || !title[1].trim()) err("title", "<title> 이 없거나 비어 있다");

  // 자기완결: 리소스 태그의 src/href 등은 data: 또는 # 만
  for (const tag of doc.match(RESOURCE_TAGS) ?? []) {
    ATTR_RE.lastIndex = 0;
    let m;
    while ((m = ATTR_RE.exec(tag)) !== null) {
      const value = m[3] ?? m[4] ?? m[5] ?? "";
      if (!attrValueOk(value)) {
        err("external-resource", `리소스 참조(외부 URL · 로컬 파일 모두 막음, data: · # 만): ${tag.slice(0, 120)}`);
      }
    }
  }

  // 자기완결: CSS — @import 는 늘 막고, url() 은 data: · # 만
  const css = cssContexts(doc);
  if (/@import\b/i.test(css)) err("css-import", "@import 는 리소스를 가져온다");
  for (const u of css.matchAll(/\burl\(\s*("([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi)) {
    const value = (u[2] ?? u[3] ?? u[4] ?? "").trim();
    if (!attrValueOk(value)) err("css-url", `CSS url() 외부 · 로컬 참조: url(${value})`);
  }

  // 색은 토큰으로: 인라인 style 과 SVG fill · stroke 속성의 색 글자는 다크를 깬다
  for (const sa of doc.matchAll(/\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const value = sa[2] ?? sa[3] ?? "";
    if (/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i.test(value)) {
      err("inline-color", `인라인 style 의 색 글자 — var(--...) 토큰을 쓴다: style="${value.slice(0, 60)}"`);
    }
  }
  for (const fa of doc.matchAll(/\b(fill|stroke)\s*=\s*"(#[0-9a-f]{3,8}|(?:rgba?|hsla?)\([^"]*\))"/gi)) {
    err("inline-color", `SVG ${fa[1]} 속성의 색 글자 — class 와 토큰을 쓴다: ${fa[0]}`);
  }

  // 점선 0: CSS 의 dashed · dotted, stroke-dasharray(none · 0 은 통과), SVG 속성
  for (const d of css.matchAll(/\b(dashed|dotted)\b/gi)) {
    err("no-dash", `CSS 에 점선(${d[1]})이 있다 — 실선 · 색 · 면으로 구분한다`);
  }
  for (const d of css.matchAll(/stroke-dasharray\s*:\s*([^;}]+)/gi)) {
    if (!/^(none|0)$/i.test(d[1].trim())) {
      err("no-dash", `CSS 에 stroke-dasharray: ${d[1].trim()} — svg-diagram 은 --solid 로 CSS 를 낸다`);
    }
  }
  if (/\bstroke-dasharray\s*=/i.test(doc)) err("no-dash", "SVG 에 stroke-dasharray 속성이 있다");

  // 테마: OS 연동 + 수동 토글. 다크 토큰은 두 자리(media · data-theme)에 같은 이름으로
  const rules = cssRules(css);
  if (!/prefers-color-scheme:\s*dark/i.test(doc)) err("theme-media", "@media (prefers-color-scheme: dark) 가 없다");
  if (!/\[data-theme="dark"\]/.test(doc) || !/\[data-theme="light"\]/.test(doc)) {
    err("theme-override", ':root[data-theme="dark"] 와 [data-theme="light"] 가 둘 다 있어야 한다');
  }
  const mediaDark = new Set();
  const attrDark = new Set();
  for (const r of rules) {
    if (!/^:root\b/.test(r.prelude)) continue;
    if (r.at && /prefers-color-scheme:\s*dark/i.test(r.at)) customProps(r.body).forEach((p) => mediaDark.add(p));
    if (!r.at && /^:root\[data-theme="dark"\]$/.test(r.prelude)) customProps(r.body).forEach((p) => attrDark.add(p));
  }
  if (!mediaDark.size || !attrDark.size) {
    err("theme-dark-tokens", '다크 토큰이 @media (prefers-color-scheme: dark) 의 :root 와 :root[data-theme="dark"] 두 자리 모두에 있어야 한다');
  } else {
    const onlyMedia = [...mediaDark].filter((p) => !attrDark.has(p));
    const onlyAttr = [...attrDark].filter((p) => !mediaDark.has(p));
    if (onlyMedia.length || onlyAttr.length) {
      err("theme-dark-tokens", `다크 토큰 두 자리가 다르다 — media 에만: ${onlyMedia.join(" ") || "없음"} / data-theme 에만: ${onlyAttr.join(" ") || "없음"}`);
    }
  }

  if (!/@media\s+print\b/i.test(doc)) err("print-css", "@media print 블록이 없다");

  // script 0 — 차례는 정적 마크업, 테마는 CSS 만
  if (/<script\b/i.test(doc)) err("no-script", "<script> 가 있다 — 차례 = 정적 nav, 테마 = CSS");

  // 머리 넷: 좌표 줄 → h1 → 부제 → 메타
  const h1s = markup.match(/<h1\b/gi) ?? [];
  if (h1s.length !== 1) err("head", `<h1> 이 ${h1s.length} 개다 — 문서 제목 하나만`);
  const at = {
    "좌표 줄 nav.coord": markup.search(/<nav\b[^>]*\bclass\s*=\s*"[^"]*\bcoord\b/i),
    "제목 h1": markup.search(/<h1\b/i),
    "부제 p.sub": markup.search(/<p\b[^>]*\bclass\s*=\s*"[^"]*\bsub\b/i),
    "메타 p.meta": markup.search(/<p\b[^>]*\bclass\s*=\s*"[^"]*\bmeta\b/i),
  };
  const missing = Object.entries(at).filter(([, i]) => i < 0).map(([k]) => k);
  if (missing.length) err("head", `머리 넷 중 빠진 것: ${missing.join(" · ")}`);
  else {
    const pos = Object.values(at);
    if (pos.some((p, i) => i > 0 && p < pos[i - 1])) {
      err("head-order", "머리 순서는 좌표 줄 → 제목 → 부제 → 메타 다");
    }
  }

  // 차례: nav.toc 에 # 링크가 하나 이상
  const toc = markup.match(/<nav\b[^>]*\bclass\s*=\s*"[^"]*\btoc\b[^"]*"[^>]*>([\s\S]*?)<\/nav>/i);
  if (!toc || !/href\s*=\s*"#[^"]+"/i.test(toc[1])) err("toc", '차례 <nav class="toc"> 와 그 안의 #링크가 없다');

  // id: 겹침 0, 문서 안 #링크는 모두 닿아야 한다
  const ids = new Map();
  for (const m of markup.matchAll(/\sid\s*=\s*"([^"]+)"/gi)) ids.set(m[1], (ids.get(m[1]) ?? 0) + 1);
  const dups = [...ids].filter(([, n]) => n > 1).map(([k]) => k);
  if (dups.length) err("dup-id", `id 가 겹친다: ${dups.join(" ")}`);
  for (const m of markup.matchAll(/\bhref\s*=\s*"#([^"]+)"/gi)) {
    if (!ids.has(m[1])) err("anchor", `#${m[1]} 링크에 닿는 id 가 없다`);
  }

  // section id — 차례 앵커의 원본. 만들 때 손으로 붙인다
  for (const sec of doc.matchAll(/<section\b([^>]*)>/gi)) {
    if (!/\bid\s*=/i.test(sec[1])) err("section-id", "id 없는 <section> — 차례 링크가 끊긴다");
  }

  // 표는 .table-scroll 안에서만 가로로 넘친다
  const tableCount = (doc.match(/<table\b/gi) ?? []).length;
  const wrappedCount = (doc.match(/table-scroll[^>]*>\s*<table\b/gi) ?? []).length;
  if (tableCount > wrappedCount) {
    err("table-scroll", `.table-scroll 밖의 <table> ${tableCount - wrappedCount} 개 — <div class="table-scroll"> 로 감싼다`);
  }

  if (/\{\{/.test(stripCodeBlocks(doc))) err("placeholder", "{{...}} 자리표시가 남아 있다");

  // 글자 크기: 제목(h1) ÷ 본문(body) ≥ 4. 미디어 밖 규칙만 읽는다
  const h1Px = fontSizePx(rules, "h1");
  const bodyPx = fontSizePx(rules, "body");
  if (h1Px == null || bodyPx == null) {
    warnings.push({ rule: "type-ratio", msg: `제목 · 본문 글자 크기를 정적 CSS 에서 읽지 못했다(h1 ${h1Px ?? "?"} px, body ${bodyPx ?? "?"} px) — 눈으로 본다` });
  } else if (h1Px / bodyPx < TYPE_RATIO) {
    err("type-ratio", `제목 ${h1Px} px ÷ 본문 ${bodyPx} px = ${(h1Px / bodyPx).toFixed(2)} — ${TYPE_RATIO} 배 이상이어야 한다`);
  }

  // 파생물 표기(md 렌더 모드)
  if (derived && !/\bdata-derived-from\s*=/i.test(doc)) {
    err("derived-footer", 'md 렌더 산출물에는 <footer class="derived" data-derived-from="<원본 경로>"> 가 있어야 한다');
  }

  return { ok: errors.length === 0, errors, warnings };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const derived = args.includes("--derived");
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: node check.mjs <file.html> [--derived]");
    process.exit(1);
  }
  const { ok, errors, warnings } = checkHtml(readFileSync(file, "utf8"), { derived });
  for (const w of warnings) console.error(`  경고 [${w.rule}] ${w.msg}`);
  if (ok) {
    console.log(`OK: ${file} — html-doc 철칙 통과${derived ? " (derived)" : ""}`);
  } else {
    console.error(`FAIL: ${file} — ${errors.length} 건`);
    for (const e of errors) console.error(`  [${e.rule}] ${e.msg}`);
    process.exit(1);
  }
}
