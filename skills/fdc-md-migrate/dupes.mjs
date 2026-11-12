#!/usr/bin/env node
// fdc-md-migrate 의 중복 찾기. 읽기만 한다. 파일을 고치지 않는다.
//
//   node dupes.mjs <폴더> [--json]
//
// <폴더> 는 AKG 에서 받은 md 를 `<타입>/<id>.md` 로 둔 곳이다:
//   <폴더>/starter/*.md · <폴더>/domain-skill/*.md · <폴더>/domain/*.md
//
// 항목은 AKG 체크아웃(AKG_DIR, 기본 ~/work/fdc-agent/agent-knowledge-governance)의
// 읽기 함수로 읽는다: src/skill-data-ids.mjs(항목) · src/skill-sections.mjs(절 · 펜스) ·
// src/flow/agent-md.mjs(흐름 노드) · src/table-class.mjs(읽는 표) · src/sql-bind.mjs(바인드 · 열).
//
// 내는 무리 셋:
//   같은 조회     에이전트 항목의 SQL 이 starter 항목의 SQL 과 같다(sameSql). 확정이다.
//   비슷한 조회   같지 않다. 읽는 표의 모음과 바인드의 모음이 starter 항목과 같다. 후보다.
//   올릴 후보     starter 에 같은 조회가 없다. 에이전트 문서 둘 이상에 같은 SQL 이 있다.
// 무리마다 옛 id 를 적은 자리(흐름 · 항목 머리 · chart · 프리셋 · 글)를 함께 낸다.
//
// 끝 코드: 0 다 읽었다(무리가 있어도 0) · 2 인자가 틀렸다 · 폴더나 AKG 체크아웃을 못 읽었다.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

export const STARTER = "starter";
export const AGENT_TYPES = ["domain-skill", "domain"];
const TYPES = [STARTER, ...AGENT_TYPES];

/** AKG 체크아웃의 읽기 함수. 없으면 Error 를 던진다. */
export async function loadAkg(akgDir) {
  const at = (p) => pathToFileURL(join(akgDir, p)).href;
  const need = join(akgDir, "src/skill-data-ids.mjs");
  if (!existsSync(need)) throw new Error(`AKG 체크아웃이 없다: ${need}. AKG_DIR 로 AKG 체크아웃을 가리킨다`);
  const [ids, sections, agentMd, tables, binds] = await Promise.all([
    import(at("src/skill-data-ids.mjs")),
    import(at("src/skill-sections.mjs")),
    import(at("src/flow/agent-md.mjs")),
    import(at("src/table-class.mjs")),
    import(at("src/sql-bind.mjs")),
  ]);
  return {
    skillDataIds: ids.skillDataIds,
    scan: sections.scan,
    normalizeHeading: sections.normalizeHeading,
    readAgentMd: agentMd.readAgentMd,
    tablesOfSql: tables.tablesOfSql,
    columnsOf: binds.columnsOf,
    varsOf: binds.varsOf,
  };
}

/**
 * 견주는 꼴의 SQL. 작은따옴표 글은 그대로 둔다. 그 밖에서:
 * 1. `--` 주석과 `/* *\/` 주석을 뗀다.
 * 2. 영문자를 소문자로 바꾼다.
 * 3. 공백 묶음을 공백 하나로 줄인다.
 * 4. `, ( ) = < > !` 양옆의 공백을 뗀다.
 * 5. 앞뒤 공백과 끝 `;` 를 뗀다.
 */
export function normalizeSql(sql) {
  const s = String(sql ?? "");
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== "'") j++;
      out += s.slice(i, j + 1);
      i = j + 1;
    } else if (c === "-" && s[i + 1] === "-") {
      while (i < s.length && s[i] !== "\n") i++;
      out += " ";
    } else if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      i = end < 0 ? s.length : end + 2;
      out += " ";
    } else {
      out += /\s/.test(c) ? " " : c.toLowerCase();
      i++;
    }
  }
  return protect(out, (t) => t.replace(/ +/g, " ").replace(/ ?([,()=<>!]) ?/g, "$1"))
    .trim()
    .replace(/[\s;]+$/, "");
}

// 작은따옴표 글 밖에만 fn 을 건다.
function protect(text, fn) {
  return text
    .split(/('[^']*'?)/)
    .map((part, k) => (k % 2 ? part : fn(part)))
    .join("");
}

const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const lower = (list) => new Set((list ?? []).map((x) => String(x).toLowerCase()));

/** 폴더의 md 를 타입별로 읽는다. 문서마다 {type, id, path, markdown}. */
export function readFolder(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`폴더가 없다: ${dir}`);
  const docs = [];
  for (const type of TYPES) {
    const sub = join(dir, type);
    if (!existsSync(sub)) continue;
    for (const f of readdirSync(sub).sort()) {
      if (!f.endsWith(".md")) continue;
      docs.push({ type, id: f.slice(0, -3), path: join(sub, f), markdown: readFileSync(join(sub, f), "utf8") });
    }
  }
  if (!docs.some((d) => d.type === STARTER)) throw new Error(`starter 문서가 없다: ${join(dir, STARTER)}/*.md`);
  if (!docs.some((d) => AGENT_TYPES.includes(d.type))) throw new Error(`에이전트 문서가 없다: ${join(dir, "domain-skill")}/*.md`);
  return docs;
}

/**
 * 한 문서에서 id 가 낱말로 나온 줄. 자리는 흐름 · 항목 머리 · chart · map · sql · 프리셋 · 글 가운데 하나다.
 * sql 펜스 안의 줄은 열 이름과 겹칠 수 있어 뺀다.
 */
export function placesOf(akg, doc, id) {
  const word = new RegExp(`(^|[^A-Za-z0-9_])${id}(?![A-Za-z0-9_])`);
  const flowIds = new Set();
  if (AGENT_TYPES.includes(doc.type)) {
    const read = akg.readAgentMd(doc.id, doc.markdown);
    for (const n of read.flow.nodes) flowIds.add(n.id);
  }
  const out = [];
  let section = null;
  let lang = null;
  let inItem = false;
  akg.scan(doc.markdown).forEach(({ line, heading, fenced }, i) => {
    if (heading !== null) {
      section = akg.normalizeHeading(heading);
      inItem = false;
      return;
    }
    const opens = fenced && lang === null && /^(`{3,}|~{3,})/.test(line);
    if (opens) {
      lang = /^(?:`{3,}|~{3,})\s*([A-Za-z0-9_-]*)/.exec(line)[1].toLowerCase();
      return;
    }
    if (fenced && lang !== null && !/^(`{3,}|~{3,})\s*$/.test(line.trim())) {
      if (!word.test(line)) return;
      if (lang === "mermaid" && section === "데이터" && !inItem && flowIds.has(id)) out.push({ line: i + 1, place: "흐름" });
      else if (lang === "chart" || lang === "map") out.push({ line: i + 1, place: lang });
      return;
    }
    if (fenced) {
      lang = null;
      return;
    }
    if (/^###\s/.test(line) && section === "데이터") {
      inItem = true;
      const head = /^###\s+([A-Za-z][A-Za-z0-9_]*)/.exec(line)?.[1];
      if (head === id) out.push({ line: i + 1, place: "항목 머리" });
      else if (word.test(line)) out.push({ line: i + 1, place: "글" });
      return;
    }
    if (!word.test(line)) return;
    out.push({ line: i + 1, place: section === "프리셋" ? "프리셋" : "글" });
  });
  return out;
}

/** 폴더 하나의 세 무리. 경로는 base 기준이다. */
export function findDupes(akg, docs, base = "") {
  const rel = (p) => (base ? relative(base, p) : p);
  const items = [];
  const rejected = [];
  for (const doc of docs) {
    const charts = new Set();
    if (AGENT_TYPES.includes(doc.type)) {
      const read = akg.readAgentMd(doc.id, doc.markdown);
      if (read.rejection) rejected.push({ doc: rel(doc.path), reason: read.rejection });
      for (const q of read.queries) if (q.chart) charts.add(q.id);
    }
    for (const it of akg.skillDataIds(doc.markdown)) {
      if (it.kind !== "sql" || !it.sql) continue;
      items.push({
        type: doc.type,
        doc: doc.id,
        path: rel(doc.path),
        id: it.id,
        title: it.title,
        line: it.line,
        sql: it.sql,
        norm: normalizeSql(it.sql),
        tables: akg.tablesOfSql(it.sql),
        binds: (akg.varsOf(it.sql) ?? []).map((b) => b.toLowerCase()),
        columns: akg.columnsOf(it.sql),
        carries: [...(charts.has(it.id) ? ["chart 펜스"] : []), ...(it.text ? ["산문"] : [])],
      });
    }
  }
  const starters = items.filter((x) => x.type === STARTER);
  const agents = items.filter((x) => x.type !== STARTER);
  const where = (id) =>
    docs.flatMap((d) => placesOf(akg, d, id).map((p) => ({ path: rel(d.path), ...p })));

  const same = [];
  const similar = [];
  const matched = new Set();
  for (const a of agents) {
    const hit = starters.find((s) => s.norm === a.norm);
    if (hit) {
      matched.add(a);
      same.push({ starter: hit, item: a, places: where(a.id) });
      continue;
    }
    for (const s of starters) {
      if (!a.tables.length || !sameSet(lower(a.tables), lower(s.tables)) || !sameSet(new Set(a.binds), new Set(s.binds))) continue;
      const ac = a.columns && lower(a.columns);
      const sc = s.columns && lower(s.columns);
      similar.push({
        starter: s,
        item: a,
        onlyItem: ac && sc ? [...ac].filter((c) => !sc.has(c)) : null,
        onlyStarter: ac && sc ? [...sc].filter((c) => !ac.has(c)) : null,
        places: where(a.id),
      });
    }
  }
  const byNorm = new Map();
  for (const a of agents) {
    if (matched.has(a)) continue;
    if (!byNorm.has(a.norm)) byNorm.set(a.norm, []);
    byNorm.get(a.norm).push(a);
  }
  const promote = [...byNorm.values()]
    .filter((list) => new Set(list.map((x) => `${x.type}/${x.doc}`)).size >= 2)
    .map((list) => ({ items: list, places: list.flatMap((x) => where(x.id)) }));
  return { same, similar, promote, rejected };
}

const at = (x) => `${x.path}:${x.line}`;
const placeText = (places) =>
  places.length ? places.map((p) => `${p.path}:${p.line} ${p.place}`).join("<br>") : "(없음)";
const carries = (x) => (x.carries.length ? x.carries.join(" · ") : "없음");
const cols = (list) => (list === null ? "알 수 없음" : list.length ? list.join(", ") : "없음");

/** 사람에게 보일 표. */
export function render(r) {
  const out = [];
  out.push("## 같은 조회(확정)", "");
  out.push("| starter 항목 | 에이전트 항목 | 항목에 든 것 | 옛 id 를 적은 자리 |", "| --- | --- | --- | --- |");
  for (const g of r.same)
    out.push(`| ${g.starter.id} (${at(g.starter)}) | ${g.item.id} (${at(g.item)}) | ${carries(g.item)} | ${placeText(g.places)} |`);
  if (!r.same.length) out.push("| (없음) | | | |");
  out.push("", "## 비슷한 조회(후보)", "");
  out.push(
    "| starter 항목 | 에이전트 항목 | 표 · 바인드 | 에이전트에만 있는 열 | starter 에만 있는 열 | 항목에 든 것 | 옛 id 를 적은 자리 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const g of r.similar)
    out.push(
      `| ${g.starter.id} (${at(g.starter)}) | ${g.item.id} (${at(g.item)}) | ${g.item.tables.join(", ")} · ${g.item.binds.map((b) => ":" + b).join(", ") || "없음"} | ${cols(g.onlyItem)} | ${cols(g.onlyStarter)} | ${carries(g.item)} | ${placeText(g.places)} |`,
    );
  if (!r.similar.length) out.push("| (없음) | | | | | | |");
  out.push("", "## starter 로 올릴 후보", "");
  out.push("| 에이전트 항목 | 표 · 바인드 | 옛 id 를 적은 자리 |", "| --- | --- | --- |");
  for (const g of r.promote) {
    const first = g.items[0];
    out.push(
      `| ${g.items.map((x) => `${x.id} (${at(x)})`).join("<br>")} | ${first.tables.join(", ")} · ${first.binds.map((b) => ":" + b).join(", ") || "없음"} | ${placeText(g.places)} |`,
    );
  }
  if (!r.promote.length) out.push("| (없음) | | |");
  if (r.rejected.length) {
    out.push("", "## 읽지 못한 에이전트 문서", "");
    for (const x of r.rejected) out.push(`- ${x.doc}: ${x.reason}`);
  }
  return out.join("\n");
}

async function main(argv) {
  const args = argv.filter((a) => a !== "--json");
  if (args.length !== 1 || args[0].startsWith("-")) {
    console.error("쓰는 법: node dupes.mjs <폴더> [--json]   (폴더 아래 starter/ · domain-skill/ · domain/ 의 *.md)");
    return 2;
  }
  const dir = args[0];
  const akgDir = process.env.AKG_DIR || join(homedir(), "work/fdc-agent/agent-knowledge-governance");
  let akg;
  let docs;
  try {
    akg = await loadAkg(akgDir);
    docs = readFolder(dir);
  } catch (err) {
    console.error(`dupes: ${err.message}`);
    return 2;
  }
  const r = findDupes(akg, docs, dir);
  if (argv.includes("--json")) {
    const strip = (x) => ({
      type: x.type, doc: x.doc, path: x.path, id: x.id, title: x.title, line: x.line,
      tables: x.tables, binds: x.binds, columns: x.columns, carries: x.carries,
    });
    console.log(
      JSON.stringify(
        {
          same: r.same.map((g) => ({ starter: strip(g.starter), item: strip(g.item), places: g.places })),
          similar: r.similar.map((g) => ({ starter: strip(g.starter), item: strip(g.item), onlyItem: g.onlyItem, onlyStarter: g.onlyStarter, places: g.places })),
          promote: r.promote.map((g) => ({ items: g.items.map(strip), places: g.places })),
          rejected: r.rejected,
        },
        null,
        2,
      ),
    );
  } else console.log(render(r));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main(process.argv.slice(2));
