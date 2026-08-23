#!/usr/bin/env node
// Regression tests for the svg-figure output checker (check-svg.mjs).
// Run: node skills/svg-figure/test.mjs
//
// Pure offline tests — 픽스처를 규칙별로 변형해 checkSvg를 검증하고, 마지막으로
// templates/*.svg 와 examples/showcase.svg 가 자기 철칙을 통과하는지 본다(골든).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkSvg } from "./check-svg.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const HEAD = `<svg xmlns="http://www.w3.org/2000/svg" id="fx" viewBox="0 0 400 200" width="100%">`;
const DEFS = `
  <defs>
    <marker id="fx-arrow" viewBox="0 0 8 8" refX="7" refY="4"
            markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0,0 L8,4 L0,8 z" fill="#47535B"/>
    </marker>
  </defs>`;
const BODY = `
  <rect x="0" y="0" width="400" height="200" fill="#F9FAFA"/>
  <rect x="24" y="24" width="200" height="64" rx="4" fill="#FFFFFF" stroke="#D2D8DB"/>
  <text x="124" y="56" font-size="13" fill="#14181B" text-anchor="middle">테스트</text>
  <line x1="24" y1="120" x2="224" y2="120" stroke="#47535B" marker-end="url(#fx-arrow)"/>`;

const validSvg = () => `${HEAD}${DEFS}${BODY}\n</svg>\n`;
const rules = (svg) => checkSvg(svg).errors.map((e) => e.rule);

test("정상 픽스처는 통과한다", () => {
  const { ok, errors } = checkSvg(validSvg());
  assert.deepEqual(errors, []);
  assert.ok(ok);
});

test("svg-root: xmlns가 없으면 반려", () => {
  const s = validSvg().replace(' xmlns="http://www.w3.org/2000/svg"', "");
  assert.ok(rules(s).includes("svg-root"));
});

test("root-id: 루트 id가 없으면 반려", () => {
  assert.ok(rules(validSvg().replace(' id="fx"', "")).includes("root-id"));
});

test("viewbox: viewBox가 없거나 960을 넘으면 반려", () => {
  assert.ok(rules(validSvg().replace(' viewBox="0 0 400 200"', "")).includes("viewbox"));
  assert.ok(rules(validSvg().replace("0 0 400 200", "0 0 1200 200")).includes("viewbox"));
});

test("responsive: 루트 height 금지, width는 100%만", () => {
  assert.ok(rules(validSvg().replace('width="100%"', 'width="100%" height="200"')).includes("responsive"));
  assert.ok(rules(validSvg().replace('width="100%"', 'width="400"')).includes("responsive"));
});

test("no-script: <script>와 이벤트 속성을 잡는다", () => {
  assert.ok(rules(validSvg().replace("</svg>", "<script>0</script></svg>")).includes("no-script"));
  assert.ok(rules(validSvg().replace("<text ", '<text onclick="x()" ')).includes("no-script"));
});

test("external-ref: 원격 참조·@import·url()을 잡는다", () => {
  assert.ok(rules(validSvg().replace("</svg>", '<image href="https://x/y.png"/></svg>')).includes("external-ref"));
  assert.ok(rules(validSvg().replace("</svg>", "<style>#fx{}@import url(x.css);</style></svg>")).includes("external-ref"));
  assert.ok(rules(validSvg().replace('fill="#F9FAFA"', 'fill="url(https://x/y)"')).includes("external-ref"));
});

test("external-ref: data: URI와 #조각은 허용한다", () => {
  const s = validSvg().replace("</svg>", '<image href="data:image/gif;base64,R0lGOD" x="0" y="0" width="8" height="8"/></svg>');
  assert.ok(!rules(s).includes("external-ref"));
});

test("webfont: @font-face 금지", () => {
  const s = validSvg().replace("</svg>", "<style>#fx{}@font-face{font-family:x}</style></svg>");
  assert.ok(rules(s).includes("webfont"));
});

test("background: 캔버스를 덮는 rect가 없으면 반려", () => {
  const s = validSvg().replace('<rect x="0" y="0" width="400" height="200" fill="#F9FAFA"/>', "");
  assert.ok(rules(s).includes("background"));
});

test("id-prefix: 루트 id 접두사가 없는 id를 잡는다", () => {
  assert.ok(rules(validSvg().replaceAll("fx-arrow", "arrow")).includes("id-prefix"));
});

test("style-scope: 루트 id로 스코프하지 않은 셀렉터를 잡는다", () => {
  const leaky = validSvg().replace("</svg>", "<style>.box { fill: #FFFFFF; }</style></svg>");
  assert.ok(rules(leaky).includes("style-scope"));
  const scoped = validSvg().replace("</svg>", "<style>#fx .box { fill: #FFFFFF; }</style></svg>");
  assert.ok(!rules(scoped).includes("style-scope"));
});

test("grid: 4의 배수가 아닌 좌표를 잡는다", () => {
  assert.ok(rules(validSvg().replace('x="24" y="24"', 'x="25" y="24"')).includes("grid"));
});

test("grid: 모서리 반경(rx)은 좌표가 아니므로 통과한다", () => {
  assert.ok(!rules(validSvg().replace('rx="4"', 'rx="6"')).includes("grid"));
});

test("grid: defs 안(marker 정의)은 격자 검사에서 뺀다", () => {
  assert.ok(!rules(validSvg()).includes("grid"));
});

test("viewbox-overflow: 캔버스 밖으로 나가는 rect를 잡는다", () => {
  const s = validSvg().replace("</svg>", '<rect x="300" y="24" width="200" height="64" fill="#FFFFFF"/></svg>');
  assert.ok(rules(s).includes("viewbox-overflow"));
});

test("rect-overlap: 부분 겹침은 잡고 완전 포함은 허용한다", () => {
  const overlap = validSvg().replace("</svg>", '<rect x="200" y="48" width="200" height="64" fill="#FFFFFF"/></svg>');
  assert.ok(rules(overlap).includes("rect-overlap"));

  const nested = validSvg().replace("</svg>", '<rect x="40" y="40" width="80" height="32" fill="#FFFFFF"/></svg>');
  assert.ok(!rules(nested).includes("rect-overlap"));
});

test("text-overflow: 박스를 넘는 글자 수를 잡는다", () => {
  const long = validSvg().replace(">테스트<", ">아주아주아주아주긴라벨이박스를넘어간다<");
  assert.ok(rules(long).includes("text-overflow"));
});

test("text-overflow: tspan 두 줄로 나누면 통과한다", () => {
  const split = validSvg().replace(
    ">테스트<",
    '><tspan x="124" y="48">아주아주아주긴라벨</tspan><tspan x="124" y="64">두 줄로 나눔</tspan><',
  );
  assert.ok(!rules(split).includes("text-overflow"));
});

test("palette: 팔레트 밖의 색을 잡는다", () => {
  assert.ok(rules(validSvg().replace('fill="#14181B"', 'fill="#FF0000"')).includes("palette"));
  assert.ok(!rules(validSvg().replace('fill="#14181B"', 'fill="none"')).includes("palette"));
});

test("templates/*.svg: 템플릿이 자기 철칙을 통과한다 (골든)", () => {
  const dir = join(HERE, "templates");
  const files = readdirSync(dir).filter((f) => f.endsWith(".svg"));
  assert.ok(files.length >= 3, "템플릿이 3개 미만이다");
  for (const f of files) {
    const { errors } = checkSvg(readFileSync(join(dir, f), "utf8"));
    assert.deepEqual(errors, [], `${f}가 철칙을 어긴다`);
  }
});

test("examples/showcase.svg: 완성 견본이 철칙을 통과한다 (골든)", () => {
  const { errors } = checkSvg(readFileSync(join(HERE, "examples", "showcase.svg"), "utf8"));
  assert.deepEqual(errors, [], "showcase.svg가 철칙을 어긴다");
});
