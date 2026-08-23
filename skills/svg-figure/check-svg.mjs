#!/usr/bin/env node
// svg-figure 산출물 검증기 — 그린 SVG가 스킬의 철칙을 지키는지 정적 검사한다.
// Run: node skills/svg-figure/check-svg.mjs <file.svg>
//
// 검사 항목: 루트 계약(svg/xmlns/id/viewBox/반응형), 자기완결(외부 참조 0,
// 웹폰트 금지), JS 0(script·on* 금지), 배경 rect, id 접두사(Confluence 다중
// 도형 충돌), <style> 스코프(매크로 스타일 누수), 격자 정합(4px 배수),
// viewBox 이탈, rect 부분 겹침, 텍스트 오버플로 추정, 팔레트 밖 색.
//
// 레이아웃이 깨지는 경로는 대부분 좌표 계산이다 — 그래서 이탈·겹침·오버플로
// 세 규칙이 이 검증기의 본체다. 단 path로 그린 도형의 겹침은 보지 않으므로
// PNG 육안 확인을 대체하지 않는다 (SKILL.md 절차 4).

import { readFileSync } from "node:fs";
import { basename } from "node:path";

const PALETTE = new Set(
  ["#14181B", "#47535B", "#6E7C85", "#D2D8DB", "#E2E6E8",
   "#F9FAFA", "#FFFFFF", "#E5E9EA", "#A8451A", "#3F6180"].map((h) => h.toUpperCase()),
);
const COLOR_KEYWORDS = new Set(["none", "transparent", "currentcolor", "inherit"]);

// 글자 폭 단위: 한글·CJK = 1.0, 그 외 = 0.55 (grid.md 상한표의 근거)
const WIDE = /[ᄀ-ᇿ㄰-㆏가-힣぀-ヿ一-鿿！-｠]/;
const TEXT_PADDING = 24; // 박스 좌우 패딩 12씩

const GRID = 4;
// 반경(r·rx·ry)은 배치가 아니라 모양이므로 격자 규칙에서 뺀다 — 모서리 반경 6은 오류가 아니다.
const SHAPE_COORDS = ["x", "y", "width", "height", "cx", "cy", "x1", "y1", "x2", "y2"];
const GRID_TAGS = new Set(["rect", "line", "circle", "ellipse", "text", "tspan", "polygon", "polyline"]);

const TAG_RE = /<([a-zA-Z][\w:-]*)\b([^>]*?)(\/?)>/g;
const ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

function parseAttrs(raw) {
  const out = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(raw)) !== null) out[m[1]] = m[2];
  return out;
}

// defs 안(marker·gradient 정의)은 캔버스 좌표계가 아니므로 격자·이탈 검사에서 뺀다.
function defsRanges(svg) {
  const ranges = [];
  const RE = /<defs\b[\s\S]*?<\/defs>/gi;
  let m;
  while ((m = RE.exec(svg)) !== null) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}

function num(v) {
  if (v === undefined) return undefined;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : undefined;
}

export function checkSvg(svg, { name = "figure" } = {}) {
  const errors = [];
  const add = (rule, msg) => errors.push({ rule, msg });
  const body = svg.replace(/<!--[\s\S]*?-->/g, "");

  // ── 루트 계약 ──────────────────────────────────────────────
  const rootMatch = body.match(/<svg\b([^>]*)>/i);
  if (!rootMatch) {
    add("svg-root", "<svg> 루트가 없다");
    return { ok: false, errors };
  }
  const root = parseAttrs(rootMatch[1]);

  if (!/xmlns\s*=\s*"http:\/\/www\.w3\.org\/2000\/svg"/i.test(rootMatch[1])) {
    add("svg-root", 'xmlns="http://www.w3.org/2000/svg"가 없다 — 파일로 열면 렌더되지 않는다');
  }

  const rootId = root.id;
  if (!rootId) {
    add("root-id", "루트 <svg>에 id가 없다 — id 접두사와 <style> 스코프의 기준이다");
  }

  let vb = null;
  if (!root.viewBox) {
    add("viewbox", "viewBox가 없다 — 반응형 크기의 근거다");
  } else {
    const parts = root.viewBox.trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      add("viewbox", `viewBox 값이 숫자 4개가 아니다: "${root.viewBox}"`);
    } else {
      vb = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
      if (vb.w > 960) add("viewbox", `캔버스 폭 ${vb.w} — 최대 960이다 (grid.md). 도형을 쪼갠다`);
    }
  }

  if (root.height !== undefined) {
    add("responsive", `루트에 height="${root.height}" — 종횡비로 계산되게 height는 쓰지 않는다`);
  }
  if (root.width !== undefined && root.width !== "100%") {
    add("responsive", `루트 width는 "100%"만 쓴다 (현재 "${root.width}")`);
  }

  // ── JS 0 ──────────────────────────────────────────────────
  if (/<script\b/i.test(body)) add("no-script", "<script>가 있다 — 도형에 JS를 넣지 않는다");
  for (const m of body.matchAll(/\s(on[a-z]+)\s*=\s*"/gi)) {
    add("no-script", `이벤트 속성 ${m[1]} — Confluence 새니타이저가 벗기고 마크업이 깨진다`);
  }

  // ── 자기완결 ───────────────────────────────────────────────
  for (const m of body.matchAll(/\b(?:xlink:href|href|src)\s*=\s*"([^"]*)"/gi)) {
    const v = m[1].trim();
    if (!(v === "" || v.startsWith("#") || /^data:/i.test(v))) {
      add("external-ref", `외부 참조: ${m[0].slice(0, 80)} — data: 또는 #만 허용`);
    }
  }
  if (/<image\b/i.test(body)) {
    const okImages = [...body.matchAll(/<image\b[^>]*>/gi)].every((t) => /(?:xlink:)?href\s*=\s*"data:/i.test(t[0]));
    if (!okImages) add("external-ref", "<image>가 data: URI가 아니다");
  }
  if (/@import\b/i.test(body)) add("external-ref", "@import는 리소스를 가져온다 — 금지");
  if (/@font-face\b/i.test(body)) add("webfont", "@font-face 금지 — 시스템 폰트 스택만 쓴다");
  for (const m of body.matchAll(/\burl\(\s*['"]?([^)'"]*)['"]?\s*\)/gi)) {
    const v = m[1].trim();
    if (!(v.startsWith("#") || /^data:/i.test(v))) add("external-ref", `url(${v}) 외부 참조`);
  }

  // ── 배경 rect ─────────────────────────────────────────────
  if (vb) {
    const covered = [...body.matchAll(/<rect\b([^>]*)>/gi)].some((m) => {
      const a = parseAttrs(m[1]);
      return num(a.x) === vb.x && num(a.y) === vb.y &&
             num(a.width) === vb.w && num(a.height) === vb.h &&
             a.fill && a.fill.toLowerCase() !== "none";
    });
    if (!covered) {
      add("background", "캔버스 전체를 덮는 배경 rect가 없다 — 투명 배경은 다크 모드에서 도형이 사라진다");
    }
  }

  // ── id 접두사 (Confluence 다중 도형 충돌 방지) ──────────────
  if (rootId) {
    for (const m of body.matchAll(/\sid\s*=\s*"([^"]*)"/gi)) {
      const id = m[1];
      if (id !== rootId && !id.startsWith(`${rootId}-`)) {
        add("id-prefix", `id="${id}" — 루트 id "${rootId}-" 접두사를 붙인다 (한 페이지에 도형 둘이면 충돌)`);
      }
    }
  }

  // ── <style> 스코프 (매크로 스타일 누수) ─────────────────────
  for (const block of body.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const css = block[1].replace(/\/\*[\s\S]*?\*\//g, "");
    for (const rule of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      for (const sel of rule[1].split(",")) {
        const s = sel.trim();
        if (!s || s.startsWith("@")) continue;
        if (!rootId || !s.startsWith(`#${rootId}`)) {
          add("style-scope", `셀렉터 "${s}" — HTML 매크로의 <style>은 페이지 전역으로 샌다. "#${rootId || "<루트id>"}"로 시작해야 한다`);
        }
      }
    }
  }

  // ── 도형 수집 (defs 밖만) ──────────────────────────────────
  const skip = defsRanges(body);
  const inDefs = (i) => skip.some(([a, b]) => i >= a && i < b);

  const rects = [];
  TAG_RE.lastIndex = 0;
  let t;
  while ((t = TAG_RE.exec(body)) !== null) {
    const tag = t[1].toLowerCase();
    if (tag === "svg" || inDefs(t.index)) continue;
    const a = parseAttrs(t[2]);

    // 격자 정합
    if (GRID_TAGS.has(tag)) {
      for (const k of SHAPE_COORDS) {
        const v = num(a[k]);
        if (v !== undefined && v % GRID !== 0) {
          add("grid", `<${tag} ${k}="${a[k]}"> — 좌표는 ${GRID}의 배수여야 한다 (grid.md 상수를 더해 만든다)`);
        }
      }
      if (a.points) {
        for (const p of a.points.trim().split(/[\s,]+/).map(Number)) {
          if (Number.isFinite(p) && p % GRID !== 0) {
            add("grid", `<${tag} points> 좌표 ${p} — ${GRID}의 배수여야 한다`);
          }
        }
      }
    }

    // 팔레트
    for (const k of ["fill", "stroke"]) {
      const v = a[k];
      if (v === undefined) continue;
      const lv = v.trim().toLowerCase();
      if (COLOR_KEYWORDS.has(lv) || lv.startsWith("url(")) continue;
      if (!PALETTE.has(v.trim().toUpperCase())) {
        add("palette", `<${tag} ${k}="${v}"> — grid.md 팔레트 밖의 색`);
      }
    }

    if (tag === "rect") {
      const r = { x: num(a.x), y: num(a.y), w: num(a.width), h: num(a.height) };
      if ([r.x, r.y, r.w, r.h].every((n) => n !== undefined)) rects.push(r);
    }
  }

  // ── viewBox 이탈 ──────────────────────────────────────────
  if (vb) {
    for (const r of rects) {
      if (r.x < vb.x || r.y < vb.y || r.x + r.w > vb.x + vb.w || r.y + r.h > vb.y + vb.h) {
        add("viewbox-overflow", `rect(${r.x},${r.y},${r.w},${r.h})가 캔버스 밖으로 나간다 — 잘려서 렌더된다`);
      }
    }
  }

  // ── rect 부분 겹침 (완전 포함은 컨테이너라 허용) ─────────────
  const contains = (a, b) =>
    a.x <= b.x && a.y <= b.y && a.x + a.w >= b.x + b.w && a.y + a.h >= b.y + b.h;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 0 && oy > 0 && !contains(a, b) && !contains(b, a)) {
        add("rect-overlap", `rect(${a.x},${a.y},${a.w},${a.h})와 rect(${b.x},${b.y},${b.w},${b.h})가 부분 겹침 — 레이아웃이 깨졌다`);
      }
    }
  }

  // ── 텍스트 오버플로 추정 ───────────────────────────────────
  for (const m of body.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
    if (inDefs(m.index)) continue;
    const attrs = parseAttrs(m[1]);
    const size = num(attrs["font-size"]) ?? 13;
    const cx = num(attrs.x), cy = num(attrs.y);
    if (cx === undefined || cy === undefined) continue;

    // 이 텍스트를 담는 가장 작은 rect (배경 rect는 컨테이너로 치지 않는다)
    const host = rects
      .filter((r) => r.x < cx && cx < r.x + r.w && r.y < cy && cy < r.y + r.h)
      .filter((r) => !(vb && r.w === vb.w && r.h === vb.h))
      .sort((p, q) => p.w * p.h - q.w * q.h)[0];
    if (!host) continue;

    const capacity = (host.w - TEXT_PADDING) / size;
    const tspans = [...m[2].matchAll(/<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/gi)];
    const lines = tspans.length
      ? tspans.map((s) => ({ text: s[2], size: num(parseAttrs(s[1])["font-size"]) ?? size }))
      : [{ text: m[2], size }];

    for (const line of lines) {
      const plain = line.text.replace(/<[^>]*>/g, "").trim();
      if (!plain) continue;
      let units = 0;
      for (const ch of plain) units += WIDE.test(ch) ? 1 : 0.55;
      const cap = (host.w - TEXT_PADDING) / line.size;
      if (units > cap) {
        add("text-overflow",
          `"${plain}"이 폭 ${host.w} 박스를 넘는다 (추정 ${units.toFixed(1)} > ${cap.toFixed(1)} 글자분) — grid.md 상한표를 보고 tspan 2줄로 나눈다`);
      }
    }
    void capacity;
  }

  return { ok: errors.length === 0, errors };
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: node check-svg.mjs <file.svg>");
    process.exit(1);
  }
  const { ok, errors } = checkSvg(readFileSync(file, "utf8"), { name: basename(file, ".svg") });
  if (ok) {
    console.log(`OK: ${file} — svg-figure 철칙 통과`);
  } else {
    console.error(`FAIL: ${file} — ${errors.length}건`);
    for (const e of errors) console.error(`  [${e.rule}] ${e.msg}`);
    process.exit(1);
  }
}
