#!/usr/bin/env node
// AKG md 문서의 ```mermaid 펜스를 AKG 와 같은 mermaid 배포본 · 같은 설정으로 그려 본다.
// 그리기는 headless Chrome 이 한다(mermaid 는 DOM 이 있어야 그린다). 의존성 설치 0.
//
//   node check.mjs <문서.md> [문서.md …] [--mermaid <mermaid.min.js>]
//
// 끝 코드: 0 모두 그려짐 · 1 그리지 못한 펜스가 있음 · 2 준비 문제(파일 · Chrome 없음).
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_JS = join(
  homedir(),
  "work/fdc-agent/agent-knowledge-governance/public/vendor/mermaid/mermaid.min.js",
);
// AKG 읽기 칸(ui.css `.cols > .main`)의 최대 폭. 이보다 넓은 그림은 칸에 맞춰 줄고 글자도 작아진다.
const MAX_W = 720;
// 1440×900 화면에서 머리 띠(56px)를 뺀 높이. 이보다 높은 그림은 한 화면을 넘는다.
const MAX_H = 800;
// AKG public/js/mermaid-frame.mjs 의 mermaid.initialize 와 같은 값. 글꼴 · 글자 크기는
// AKG mermaidTheme(public/lib/mermaid-src.mjs)이 주는 값(--sans · 14px)이다. 그림 크기가 AKG 와 맞는다.
const SANS =
  'Pretendard, "Pretendard Variable", "Noto Sans KR", "Noto Sans CJK KR", "Apple SD Gothic Neo", "Malgun Gothic", system-ui, sans-serif';
const AKG_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  themeVariables: { fontFamily: SANS, fontSize: "14px" },
};
// AKG public/lib/md-parse.mjs 의 FENCE 와 같은 규칙.
const FENCE = /^(`{3,}|~{3,})\s*([\w-]*)\s*$/;

/** md 의 ```mermaid 펜스. line = 여는 펜스의 문서 줄(1 부터). */
export function mermaidFences(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const f = FENCE.exec(lines[i]);
    if (!f) continue;
    const start = i;
    const body = [];
    i++;
    while (i < lines.length && !lines[i].trim().startsWith(f[1]))
      body.push(lines[i++]);
    if (f[2].toLowerCase() === "mermaid")
      out.push({ line: start + 1, text: body.join("\n") });
  }
  return out;
}

/** AKG 화면에서 쓴 뜻과 다르게 보이는 줄. → [{k, note}] (k = 도식 줄, 1 부터) */
export function lintFence(text) {
  const notes = [];
  String(text)
    .split("\n")
    .forEach((raw, i) => {
      const line = raw.trim();
      const k = i + 1;
      if (/^click\s/.test(line))
        notes.push({
          k,
          note: "click 줄은 지운다(링크 click 은 AKG 에서 그림을 깨뜨린다). 링크는 본문 글에 둔다",
        });
      if (/^%%\{/.test(line))
        notes.push({
          k,
          note: "%%{init}%% 지시문은 AKG 테마를 덮는다. 지운다",
        });
      if (/^(style|classDef|linkStyle)\s/.test(line) || /:::/.test(line))
        notes.push({
          k,
          note: "색 지정은 다크 화면에서 그대로 남는다. 테마 색에 맡긴다",
        });
      if (/\[\[[^\]]+\]\]/.test(line))
        notes.push({
          k,
          note: "펜스 안 [[ ]] 는 글자로 남는다. 링크는 본문 글에 둔다",
        });
    });
  return notes;
}

/** mermaid 오류 글의 도식 줄("on line 3"). 끝 다음 줄을 가리키면 끝 줄로 맞춘다(AKG mermaidError 와 같다). */
export function errorLine(message, text) {
  const m = /\bon line (\d+)/i.exec(String(message));
  if (!m) return null;
  return Math.min(Number(m[1]), String(text).split("\n").length);
}

function findChrome() {
  for (const bin of [
    process.env.CHROME,
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ]) {
    if (!bin) continue;
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch {
      // 다음 후보
    }
  }
  return null;
}

const PAGE = (
  jsUrl,
  fences,
) => `<!DOCTYPE html><html><head><meta charset="utf-8">
<script src="${jsUrl}"></script></head><body><pre id="out">pending</pre><script>
(async () => {
  const texts = ${JSON.stringify(fences.map((f) => f.text))};
  const res = [];
  try {
    mermaid.initialize(${JSON.stringify(AKG_CONFIG)});
    for (let i = 0; i < texts.length; i++) {
      try {
        const { svg } = await mermaid.render("chk" + i, texts[i]);
        const doc = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
        // AKG svgNode(public/js/mermaid.mjs)와 같은 판정: XML 로 읽어 뿌리가 svg 가 아니면 오류.
        if (doc.nodeName !== "svg" || doc.querySelector("parsererror")) {
          res.push({ ok: false, message: "SVG 를 읽지 못했습니다" });
          continue;
        }
        const vb = (doc.getAttribute("viewBox") || "").split(/\\s+/).map(Number);
        res.push({ ok: true, type: doc.getAttribute("aria-roledescription"), w: Math.round(vb[2] || 0), h: Math.round(vb[3] || 0) });
      } catch (e) {
        res.push({ ok: false, message: String((e && e.message) || e) });
      }
    }
  } catch (e) {
    res.push({ fatal: String((e && e.message) || e) });
  }
  const bytes = new TextEncoder().encode(JSON.stringify(res));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  document.getElementById("out").textContent = "RESULT:" + btoa(bin);
})();
</script></body></html>`;

/** 펜스들을 Chrome 에서 그린다. → [{ok, type, w, h} | {ok:false, message}] */
export function renderFences(
  fences,
  { js = DEFAULT_JS, chrome = findChrome() } = {},
) {
  if (!fences.length) return [];
  if (!existsSync(js))
    throw new Error(`mermaid 배포본이 없습니다: ${js} (--mermaid 로 준다)`);
  if (!chrome)
    throw new Error("Chrome 이 없습니다 (CHROME 환경변수로 실행 파일을 준다)");
  const dir = mkdtempSync(join(tmpdir(), "akg-mmd-"));
  try {
    const page = join(dir, "page.html");
    writeFileSync(page, PAGE(pathToFileURL(resolve(js)).href, fences));
    const dom = execFileSync(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        `--user-data-dir=${join(dir, "profile")}`,
        "--virtual-time-budget=30000",
        "--dump-dom",
        pathToFileURL(page).href,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
        timeout: 120000,
      },
    );
    const m = /RESULT:([A-Za-z0-9+/=]+)/.exec(dom);
    if (!m) throw new Error("Chrome 이 결과를 내지 못했습니다");
    const res = JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
    if (res[0]?.fatal)
      throw new Error(`mermaid 를 띄우지 못했습니다: ${res[0].fatal}`);
    return res;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main(argv) {
  const files = [];
  let js = DEFAULT_JS;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--mermaid") js = argv[++i];
    else files.push(argv[i]);
  }
  if (!files.length || !js) {
    console.error(
      "쓰는 법: node check.mjs <문서.md> [문서.md …] [--mermaid <mermaid.min.js>]",
    );
    return 2;
  }
  let failed = 0;
  let warned = 0;
  for (const file of files) {
    let md;
    try {
      md = readFileSync(file, "utf8");
    } catch (e) {
      console.error(`${file}: 읽지 못했습니다 (${e.code ?? e.message})`);
      return 2;
    }
    const fences = mermaidFences(md);
    if (!fences.length) {
      console.log(`${file}: mermaid 펜스 0 개`);
      continue;
    }
    let res;
    try {
      res = renderFences(fences, { js });
    } catch (e) {
      console.error(e.message);
      return 2;
    }
    fences.forEach((f, n) => {
      const r = res[n];
      const at = `${file}:${f.line}`;
      if (r.ok) {
        const size = `${r.w}×${r.h}px`;
        console.log(`ok    ${at} 도식 ${n + 1} (${r.type}, ${size})`);
        if (r.w > MAX_W) {
          warned++;
          console.log(
            `  주의 폭 ${r.w}px 가 읽기 칸 ${MAX_W}px 보다 넓다. 칸에 맞춰 줄고 글자가 작아진다`,
          );
        }
        if (r.h > MAX_H) {
          warned++;
          console.log(
            `  주의 높이 ${r.h}px 가 한 화면 ${MAX_H}px 보다 높다. 그림을 나눈다`,
          );
        }
      } else {
        failed++;
        const lines = r.message.trim().split("\n");
        const k = errorLine(lines[0], f.text);
        const where = k === null ? "" : ` ${f.line + k} 줄(도식 ${k} 줄)`;
        console.log(
          `FAIL  ${at} 도식 ${n + 1}${where}: ${lines[0].replace(/\s+on line \d+/i, "").replace(/:\s*$/, "")}`,
        );
        for (const l of lines.slice(1)) console.log(`      ${l}`);
      }
      for (const { k, note } of lintFence(f.text)) {
        warned++;
        console.log(`  주의 ${f.line + k} 줄(도식 ${k} 줄): ${note}`);
      }
    });
  }
  console.log(
    failed
      ? `그리지 못한 펜스 ${failed} 개 · 주의 ${warned} 개`
      : `모두 그려짐 · 주의 ${warned} 개`,
  );
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  process.exitCode = main(process.argv.slice(2));
