#!/usr/bin/env node
// svg-diagram — 스펙(JSON) → SVG 조각 · 미리보기 HTML · 독립 SVG · 페이지 CSS. script 0, 외부 요청 0.
//
//   node gen.mjs <스펙.json> [--style KEY] [--id 접두] [--out 파일.svg]   SVG 조각(기본: stdout). 페이지에 붙여 넣는다
//   node gen.mjs <스펙.json> --style KEY --html 파일.html                미리보기 페이지(자기완결). 열어서 넘침 · 겹침을 본다
//   node gen.mjs <스펙.json> --style KEY --svg 파일.svg                  독립 .svg(스타일 CSS 내장). README · 이미지용
//   node gen.mjs --css --style KEY[,KEY…]                                 페이지 <style> 에 한 번 넣는 CSS
//   node gen.mjs --list                                                   생성기 · 스타일 목록
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { GENERATORS, render, sized, esc } from "./lib/generators.mjs";
import {
  STYLES,
  DEFAULT_STYLE,
  byKey,
  cssFor,
  DOC_FALLBACK_CSS,
} from "./lib/styles.mjs";

const args = process.argv.slice(2);
const flag = (n) => {
  const i = args.indexOf(`--${n}`);
  return i < 0 ? null : (args[i + 1] ?? "");
};
const has = (n) => args.includes(`--${n}`);
const spec = args.find(
  (a) =>
    !a.startsWith("--") &&
    (args[args.indexOf(a) - 1] ?? "").startsWith("--") === false,
);
const die = (m) => {
  console.error(m);
  process.exit(1);
};
const styleList = () =>
  STYLES.map((s) => `  ${s.key.padEnd(10)} ${s.name} — ${s.desc}`).join("\n");

if (has("list")) {
  console.log(
    "생성기(스펙의 kind):\n" +
      Object.entries(GENERATORS)
        .map(([k, g]) => `  ${k.padEnd(10)} ${g.fit}`)
        .join("\n"),
  );
  console.log(
    `\n스타일(--style): default = ${DEFAULT_STYLE ?? "미정"}\n` + styleList(),
  );
  process.exit(0);
}

if (has("css")) {
  const keys = (flag("style") || "").split(",").filter(Boolean);
  if (!keys.length)
    die("--css 에는 --style KEY[,KEY…] 가 필요하다.\n" + styleList());
  keys.forEach((k) => {
    if (!byKey(k)) die(`스타일 "${k}" 이 없다.\n` + styleList());
  });
  process.stdout.write(cssFor(keys));
  process.exit(0);
}

if (!spec)
  die(
    "스펙 파일이 필요하다. node gen.mjs <스펙.json> --style KEY  (목록: --list)",
  );
let S;
try {
  S = JSON.parse(readFileSync(spec, "utf8"));
} catch (e) {
  die(`스펙을 읽지 못했다: ${e.message}`);
}
const key = flag("style") || S.style || DEFAULT_STYLE;
if (!key)
  die(
    '스타일이 필요하다(default 미정). --style KEY 또는 스펙의 "style".\n' +
      styleList(),
  );
const st = byKey(key);
if (!st) die(`스타일 "${key}" 이 없다.\n` + styleList());
if (!S.kind)
  die(`스펙에 "kind" 가 없다. 생성기: ${Object.keys(GENERATORS).join(", ")}`);
const id = (
  flag("id") ||
  S.id ||
  basename(spec).replace(/\.[^.]+$/, "")
).replace(/[^A-Za-z0-9_-]/g, "-");

let svg;
try {
  svg = render(S.kind, S, sized(st.key, st.geo), id);
} catch (e) {
  die(e.message);
}

if (has("html")) {
  const out = flag("html") || die("--html 에는 출력 파일이 필요하다");
  const page = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(S.title ?? id)} · ${esc(st.name)}</title>
<style>
${st.inherit ? DOC_FALLBACK_CSS + "\n" : ""}body { margin: 0; padding: 24px; background: var(--bg); color: var(--fg); font-family: var(--font-diagram); }
figure { margin: 0; max-width: 1240px; } figcaption { margin-top: 10px; font-size: 14px; color: var(--muted); }
${cssFor([st.key])}</style>
</head>
<body class="s-${st.key}">
<figure>
${svg}
<figcaption>${esc(S.caption ?? "")}</figcaption>
</figure>
</body>
</html>
`;
  writeFileSync(out, page);
  console.error(`미리보기 ${out}`);
} else if (has("svg")) {
  const out = flag("svg") || die("--svg 에는 출력 파일이 필요하다");
  const standalone = svg
    .replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ')
    .replace(
      "<defs>",
      `<style>${(st.inherit ? DOC_FALLBACK_CSS + "\n" : "") + cssFor([st.key])}</style><defs>`,
    );
  writeFileSync(out, standalone);
  console.error(`독립 SVG ${out}`);
} else if (flag("out")) {
  writeFileSync(flag("out"), svg + "\n");
  console.error(
    `SVG 조각 ${flag("out")} — 페이지 <style> 에 \`node gen.mjs --css --style ${st.key}\` 출력을 한 번 넣는다`,
  );
} else {
  process.stdout.write(svg + "\n");
}
