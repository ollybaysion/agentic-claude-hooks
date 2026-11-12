#!/usr/bin/env node
// fdc-md-migrate 중복 찾기(dupes.mjs) 테스트.
// Run: node skills/fdc-md-migrate/test.mjs   (AKG_DIR = AKG 체크아웃, 기본 ~/work/fdc-agent/agent-knowledge-governance)
//
// 임시 폴더에 starter 문서 하나와 에이전트 md 셋을 쓰고 세 무리 · 옛 id 자리 · 끝 코드를 본다.
// normalizeSql 은 AKG 없이 돈다. 나머지는 AKG 체크아웃이 없으면 건너뛴다.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findDupes, loadAkg, normalizeSql, readFolder, render } from "./dupes.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const AKG_DIR = process.env.AKG_DIR || join(homedir(), "work/fdc-agent/agent-knowledge-governance");
const NO_AKG = !existsSync(join(AKG_DIR, "src/skill-data-ids.mjs")) && `AKG 체크아웃이 없다: ${AKG_DIR}`;

const STARTER = `# 설비 바탕 데이터

## 데이터

### eqp_info — 설비 정보

설비 한 대의 바탕 정보다.

\`\`\`sql
select eqp_id, eqp_name, model_id, line_id from fdc_equipment where eqp_id = :eqp_id
\`\`\`

## 프리셋

- 기본 점검: eqp_info
`;

// 같은 조회(주석 · 대소문자 · 줄바꿈 · 끝 ;) 하나, 올릴 후보 하나.
const A = `# 가

## 데이터

\`\`\`mermaid
flowchart TD
  eqp-scope[[설비 범위]]
  eqp-scope --> eqp_base
  eqp-scope --> chamber_list
  eqp_base --> a_data
  eqp-scope --> a_data
\`\`\`

모델은 \`eqp_base\` 의 열이다.

### eqp_base — 설비 기본 정보

\`\`\`sql
-- 설비 한 대
SELECT EQP_ID, EQP_NAME, MODEL_ID, LINE_ID
FROM FDC_EQUIPMENT
WHERE EQP_ID = :eqp_id;
\`\`\`

\`\`\`chart
kind = bar
x = eqp_name
y = line_id
\`\`\`

### chamber_list — 챔버 목록

\`\`\`sql
select chamber_id from fdc_chamber where eqp_id = :eqp_id
\`\`\`

### a_data — 가 이력

\`\`\`sql
select ts from fdc_a where model_id = :model_id and ts between :start_time and :end_time
\`\`\`
`;

// 비슷한 조회 하나, 올릴 후보의 짝 하나, 다른 문서의 옛 id(eqp_base)를 흐름에 적는다.
const B = `# 나

## 데이터

\`\`\`mermaid
flowchart TD
  eqp-scope[[설비 범위]]
  eqp-scope --> eqp_model
  eqp-scope --> eqp_base
  eqp-scope --> b_chamber
  eqp_model --> b_data
  eqp_base --> b_data
  eqp-scope --> b_data
\`\`\`

### eqp_model — 설비 모델

설비의 모델이다.

\`\`\`sql
select eqp_id, model_id from fdc_equipment where eqp_id = :eqp_id order by model_id
\`\`\`

### b_chamber — 챔버

\`\`\`sql
SELECT chamber_id  FROM fdc_chamber WHERE eqp_id=:eqp_id
\`\`\`

### b_data — 나 이력

\`\`\`sql
select ts from fdc_b where model_id = :model_id and line_id = :line_id and ts between :start_time and :end_time
\`\`\`
`;

// 표는 같지만 바인드가 다르다: 무리에 들지 않는다. 글자 'A' 와 'a' 는 다른 조회다.
const C = `# 다

## 데이터

\`\`\`mermaid
flowchart TD
  line([라인])
  line --> by_line
  line --> lit_a
\`\`\`

### by_line — 라인의 설비

\`\`\`sql
select eqp_id from fdc_equipment where line = :line
\`\`\`

### lit_a — 글자

\`\`\`sql
select eqp_id from fdc_equipment where line = :line and grade = 'A'
\`\`\`
`;

const D = `# 라

## 데이터

\`\`\`mermaid
flowchart TD
  line([라인])
  line --> lit_b
\`\`\`

### lit_b — 글자

\`\`\`sql
select eqp_id from fdc_equipment where line = :line and grade = 'a'
\`\`\`
`;

// 읽지 못하는 에이전트 md(ask 펜스).
const BAD = `# 마

## 데이터

### x — 엑스

\`\`\`ask
무엇인가요?
\`\`\`
`;

function folder(files) {
  const dir = mkdtempSync(join(tmpdir(), "fdc-md-migrate-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const FILES = {
  "starter/eqp-basics.md": STARTER,
  "domain-skill/a-check.md": A,
  "domain-skill/b-check.md": B,
  "domain/c-check.md": C,
  "domain-skill/d-check.md": D,
};

const run = (args, env = {}) =>
  spawnSync(process.execPath, [join(HERE, "dupes.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, AKG_DIR, ...env },
  });

test("normalizeSql: 주석 · 대소문자 · 공백 · 끝 ; 을 고른다", () => {
  const a = normalizeSql("-- 머리\nSELECT EQP_ID ,  NAME\nFROM T /* 꼬리 */\nWHERE EQP_ID=:eqp_id ;\n");
  const b = normalizeSql("select eqp_id, name from t where eqp_id = :eqp_id");
  assert.equal(a, b);
  assert.equal(b, "select eqp_id,name from t where eqp_id=:eqp_id");
});

test("normalizeSql: 작은따옴표 글은 그대로 둔다", () => {
  assert.notEqual(normalizeSql("select 1 from t where g = 'A'"), normalizeSql("select 1 from t where g = 'a'"));
  assert.equal(normalizeSql("select 1 from t where g = 'A  -- b'"), "select 1 from t where g='A  -- b'");
});

test("같은 조회 · 비슷한 조회 · 올릴 후보", { skip: NO_AKG }, async () => {
  const akg = await loadAkg(AKG_DIR);
  const dir = folder(FILES);
  const r = findDupes(akg, readFolder(dir), dir);

  assert.deepEqual(r.same.map((g) => [g.starter.id, g.item.id, g.item.path]), [["eqp_info", "eqp_base", "domain-skill/a-check.md"]]);
  assert.deepEqual(r.same[0].item.carries, ["chart 펜스"]);

  assert.deepEqual(r.similar.map((g) => [g.starter.id, g.item.id]), [["eqp_info", "eqp_model"]]);
  assert.deepEqual(r.similar[0].onlyItem, []);
  assert.deepEqual(r.similar[0].onlyStarter, ["eqp_name", "line_id"]);
  assert.deepEqual(r.similar[0].item.carries, ["산문"]);

  assert.deepEqual(
    r.promote.map((g) => g.items.map((x) => x.id)),
    [["chamber_list", "b_chamber"]],
  );
  assert.deepEqual(r.rejected, []);
});

test("옛 id 를 적은 자리: 자기 흐름 · 다른 문서의 흐름 · 항목 머리 · 글", { skip: NO_AKG }, async () => {
  const akg = await loadAkg(AKG_DIR);
  const dir = folder(FILES);
  const r = findDupes(akg, readFolder(dir), dir);
  const places = r.same[0].places.map((p) => `${p.path}:${p.line} ${p.place}`);
  assert.deepEqual(places, [
    "domain-skill/a-check.md:8 흐름",
    "domain-skill/a-check.md:10 흐름",
    "domain-skill/a-check.md:14 글",
    "domain-skill/a-check.md:16 항목 머리",
    "domain-skill/b-check.md:9 흐름",
    "domain-skill/b-check.md:12 흐름",
  ]);
});

test("프리셋 · chart 자리", { skip: NO_AKG }, async () => {
  const akg = await loadAkg(AKG_DIR);
  const starter = STARTER.replace("- 기본 점검: eqp_info", "- 기본 점검: eqp_info, eqp_base");
  const a = A.replace("y = line_id", "y = line_id\ntitle = eqp_base 그래프");
  const dir = folder({ ...FILES, "starter/eqp-basics.md": starter, "domain-skill/a-check.md": a });
  const r = findDupes(akg, readFolder(dir), dir);
  const places = r.same[0].places.map((p) => `${p.path} ${p.place}`);
  assert.ok(places.includes("domain-skill/a-check.md chart"), places.join("\n"));
  assert.ok(places.includes("starter/eqp-basics.md 프리셋"), places.join("\n"));
});

test("표가 같아도 바인드가 다르면 무리에 들지 않는다 · 글자가 다르면 다른 조회다", { skip: NO_AKG }, async () => {
  const akg = await loadAkg(AKG_DIR);
  const dir = folder(FILES);
  const r = findDupes(akg, readFolder(dir), dir);
  const ids = [...r.same, ...r.similar].map((g) => g.item.id).concat(r.promote.flatMap((g) => g.items.map((x) => x.id)));
  for (const id of ["by_line", "lit_a", "lit_b"]) assert.ok(!ids.includes(id), id);
});

test("읽지 못한 에이전트 md 는 따로 낸다", { skip: NO_AKG }, async () => {
  const akg = await loadAkg(AKG_DIR);
  const dir = folder({ ...FILES, "domain-skill/bad.md": BAD });
  const r = findDupes(akg, readFolder(dir), dir);
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].doc, "domain-skill/bad.md");
  assert.match(r.rejected[0].reason, /ask 펜스는 쓰지 않는다/);
  assert.match(render(r), /## 읽지 못한 에이전트 문서/);
});

test("CLI: 표 셋을 내고 끝 코드 0 · 인자가 틀리면 2 · AKG 가 없으면 2 · starter 가 없으면 2", { skip: NO_AKG }, () => {
  const dir = folder(FILES);
  const ok = run([dir]);
  assert.equal(ok.status, 0, ok.stderr);
  for (const h of ["## 같은 조회(확정)", "## 비슷한 조회(후보)", "## starter 로 올릴 후보"]) assert.ok(ok.stdout.includes(h), h);
  assert.match(ok.stdout, /\| eqp_info \(starter\/eqp-basics\.md:5\) \| eqp_base \(domain-skill\/a-check\.md:16\) \| chart 펜스 \|/);

  const json = JSON.parse(run([dir, "--json"]).stdout);
  assert.deepEqual(Object.keys(json), ["same", "similar", "promote", "rejected"]);
  assert.equal(json.same[0].item.id, "eqp_base");

  assert.equal(run([]).status, 2);
  const noAkg = run([dir], { AKG_DIR: join(dir, "nope") });
  assert.equal(noAkg.status, 2);
  assert.match(noAkg.stderr, /AKG 체크아웃이 없다/);
  const noStarter = run([folder({ "domain-skill/a-check.md": A })]);
  assert.equal(noStarter.status, 2);
  assert.match(noStarter.stderr, /starter 문서가 없다/);
});
