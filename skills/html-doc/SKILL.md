---
name: html-doc
argument-hint: "[소스.md | 주제] [--artifact]"
description: >-
  산문·표·여러 섹션이 있는 설계 문서·리포트·분석 산출물을 self-contained 단일
  HTML 파일로 만든다. 세 가지 모드: 기존 md 문서 → HTML 렌더(내용 재작성 금지),
  새 설계문서를 HTML로 직접 작성, 범용 산출물(리포트·비교표·대시보드). 외부
  요청 0(사내 오프라인·Artifact CSP 겸용), 라이트/다크 테마, 정적 rail TOC,
  인쇄 CSS를 template.html 스켈레톤(editorial 디자인 v2, JS 0)으로 보장하고
  check.mjs로 기계 검증한다. 사용자가 문서·리포트를 "HTML로 만들어/변환해/
  렌더해/뽑아줘"라고 하면 발동한다. 반대로 다이어그램 한 장이 산출물의 전부이거나
  (아키텍처·시퀀스·순서도) Confluence·위키에 붙일 그림을 원하면 이 스킬이 아니라
  형제 스킬 svg-figure를 쓴다 — 여기서 만드는 건 도형이 아니라 문서다. 출력은
  로컬 파일이 기본, Artifact 퍼블리시는 옵션.
---

# html-doc

설계 문서나 분석 산출물을 **self-contained 단일 HTML 파일**로 만드는 절차.
매번 즉흥적으로 만들 때 흔들리는 것들 — 자기완결성(오프라인·CSP), 라이트/다크,
TOC, 인쇄, 문서 관례 — 을 이 폴더의 `template.html`(editorial 디자인 v2)이
스켈레톤으로 고정하고, `check.mjs`가 렌더 후 기계로 검증한다. 완성 상태의
실물은 [examples/showcase.html](examples/showcase.html)에서 확인한다 —
코어 블록 전부와 패턴 조립 하나를 담은 동봉 견본(골든 테스트 대상)이다.

세 가지 모드가 있다. 요청을 보고 판단한다:

- **모드 A — 변환**: 기존 md 문서를 HTML로 렌더. 내용은 손대지 않는다.
- **모드 B — 신규 설계문서**: 설계 논의 결과를 처음부터 HTML 문서로 작성.
- **모드 C — 범용 산출물**: 분석 리포트·비교표·시각화 페이지 등.

## 철칙 (모든 모드 공통)

1. **Self-contained — 파일 하나가 전부다.** 브라우저가 파일을 열 때 다른 것을
   가져오면 안 된다: CDN 스크립트, 웹폰트, 원격/로컬 이미지 참조, CSS
   `@import` 전부 금지. 이미지가 필요하면 `data:` URI로 임베드, 아이콘·간단한
   그림은 인라인 SVG. 같은 파일이 사내 오프라인 환경과 Artifact CSP를 동시에
   만족해야 한다. 단, `<a href="https://...">` **내비게이션 링크는 허용** —
   리소스 로드가 아니다.
2. **JS를 넣지 않는다 (check가 `no-script`로 강제).** TOC는 정적 rail 마크업,
   테마는 CSS만으로 동작한다 — 라이트 값이 `:root`, 다크 값이
   `@media (prefers-color-scheme: dark)`, 그리고 `:root[data-theme="dark"|"light"]`
   **양쪽** 오버라이드(Artifact 뷰어 계약과 동일 셀렉터, 특이도로 media를
   이긴다). 템플릿의 테마 블록 세 벌을 지우거나 합치지 않는다.
3. **언어.** 산문은 한글, 코드·식별자·`section id`는 영어. 섹션 id는
   `s1, s2, …` 순번.
4. **가로 스크롤은 컨테이너 안에서만.** 표는 `.table-scroll`(check가 강제),
   코드·다이어그램은 `pre`가 스스로 스크롤한다. `body`가 가로로 흐르면 안 된다.
5. **`section`엔 저작 시점에 `id`를 부여하고 rail 링크와 손으로 맞춘다.**
   check가 `section-id`·`rail-anchor`로 검증한다. JS로 생성하지 않는다.
6. **도형 한 장이 산출물의 전부면 여기서 멈추고 넘긴다.** 요청이
   "이 시퀀스 다이어그램을 Confluence에 붙이게 해줘" / "아키텍처 그림 그려줘"처럼
   **도형 자체가 결과물**이면 이 스킬이 아니라 `svg-figure`다 — 사용자에게 그렇게
   알리고 그 스킬로 넘긴다. 이 스킬의 패턴은 CSS로 그리므로 Confluence 에디터가
   `<style>`과 class를 벗기면 글자 더미가 된다. 판별은 한 줄이다:
   **도형이 문서 안의 한 요소면 여기, 도형이 산출물 전부면 svg-figure.**

7. **시각 블록은 패턴 결정표로 고른다.** 전부 좌표 계산 없는 순수 마크업 —
   견본은 `patterns/`에 있고 상세는 [design.md §패턴](design.md).

   | 표현할 것 | 패턴 |
   | --- | --- |
   | 파이프라인·경로·처리 단계 (좌→우) | [flow](patterns/flow.html) |
   | 정확히 두 대상의 대칭 대비 | [versus](patterns/versus.html) |
   | 대안 3안 검토 / 대표 수치 타일 | [triptych](patterns/triptych.html) |
   | 두 주체의 시간순 왕복 (내용물 포함) | [sequence](patterns/sequence.html) |
   | 실제 순서가 있는 단계 | `.steps` (인벤토리) |
   | 순서 없는 규칙·항목 묶음 | `.rules` (인벤토리) |
   | 그 외 구조·관계 (얽힌 그래프 포함) | `pre.diagram` (ASCII) |
   | 확신 없음 / 데이터가 본체 | 표 (`.table-scroll`) |

   mermaid 라이브러리 임베드는 금지(수 MB) — Artifact **전용** 산출물에서만
   뷰어 네이티브 mermaid를 써도 된다.
8. **디자인은 [design.md](design.md)의 토큰·컴포넌트 인벤토리를 따른다.**
   색·배경·테두리는 `var(--...)` 토큰만 — 인라인 `style`의 색 리터럴
   (`#hex`·`rgb()`)은 check가 반려한다(`inline-color`). 새 블록이 필요하면
   인벤토리에서 먼저 찾고, 없으면 토큰만 참조하는 클래스로 추가한다.
   액센트는 테라코타 하나 — 보조 의미가 필요할 때만 `--blue`.

## 공통 절차

1. 이 폴더의 `template.html`을 출력 경로로 **복사**한다.
2. `<!-- CONTENT:START -->`와 `<!-- CONTENT:END -->` 사이의 예시를 실제 내용으로
   교체하고, `<title>` 포함 `{{...}}` 플레이스홀더를 전부 채운다. 마커 밖의
   래퍼(head·CSS·`.page`)는 유지한다. rail 링크와 section id를 맞추고, 블록이
   필요하면 [design.md](design.md) 인벤토리의 스니펫을 복사한다. 패턴
   (flow·versus·triptych·sequence)을 쓰면 견본의 `CSS:START…END` 블록을
   `<style>` 끝에 추가로 복사한다.
3. **검증한다 (필수):**

   ```bash
   node "<이 스킬 폴더>/check.mjs" <출력.html>          # 모드 B·C
   node "<이 스킬 폴더>/check.mjs" <출력.html> --derived # 모드 A
   ```

   실패 항목을 고치고 exit 0이 될 때까지 반복한다.
4. 파일 경로를 보고하고, 브라우저로 열어 확인하라고 안내한다.

## 모드 A — md → HTML 변환

**렌더만 한다. 저작하지 않는다.** 문장 재작성·요약·순서 변경 금지 — md 구조의
1:1 매핑이다. 소스 md가 진실원이고 HTML은 파생물이다.

- 매핑: h1 → masthead(제목·메타는 eyebrow/credits로) / h2 →
  `section#sN` + `.sec-head`(번호는 문서 순서) / h3 → `h3` / 코드펜스 →
  `pre.code` / 언어 없는 펜스에 box-drawing 문자(┌─│▶ 등)가 있으면 →
  `pre.diagram` / 표 → `.table-scroll > table.picker` / 인용 블록 →
  `blockquote` / 인라인 코드 → `code`(칩 모양이 기본이다). md 개정 로그
  인용문은 `details.revlog`로 접는다. rail은 h2 목록에서 만든다.
- **출력 경로 = 소스 옆 same-basename**: `docs/foo-design.md` →
  `docs/foo-design.html`.
- **파생물 표기 (check가 `--derived`로 강제):** 문서 말미에

  ```html
  <footer class="derived" data-derived-from="<소스 상대경로>">
    이 HTML은 <span class="k"><소스 상대경로></span>에서 생성된 파생물이다
    (생성 <YYYY-MM-DD>, 소스 커밋 <git log -1 --format=%h -- 소스>).
    내용 수정은 소스 md에서.
  </footer>
  ```

  소스가 git 레포 밖이면 커밋 해시는 생략하고 그 사실을 적는다.

- **덮어쓰기 규칙**: 출력 경로에 파일이 이미 있으면 열어본다 —
  `data-derived-from`이 있으면 이 스킬의 재생성 산출물이니 그냥 덮어쓰고,
  없으면(손으로 만든 파일) 사용자에게 확인받는다.

## 모드 B — 새 설계문서를 HTML로

md 설계문서 관례를 editorial 골격으로 유지한다(템플릿 예시 콘텐츠가 이 골격):

- **masthead**: eyebrow에 `프로젝트 · 문서 종류 · 버전`(◆ 마크), h1 + `.en`
  모노 부제, standfirst = 한 줄 요약(옛 "0. 한 줄 요약" 섹션이 여기로 온다),
  credits에 작성일·짝 문서 링크.
- **개정 로그** `details.revlog` — credits 아래, 최신 항목을 위로,
  "무엇을·왜"를 한 줄로. 개정하면 eyebrow 버전을 올리고 항목을 추가한다.
- 본문은 `section#s1…` 번호 섹션(`01 목표와 비목표`, …). 대안 검토는
  triptych/versus + `.decision`(날짜·근거 필수).
- 코드 위치 인용은 `.k` 칩: `<span class="k">core/context.mjs:42</span>`.
- HTML 자신이 진실원이므로 derived footer는 **쓰지 않는다** — 문서 푸터는
  일반 `footer`(문서 이름·버전·짝 문서).

## 모드 C — 범용 산출물

리포트·비교·대시보드류. 문서 골격(masthead·rail·개정 로그)은 필요한 만큼만
가져가되 철칙은 전부 적용된다. 리포트 머리 대표 수치는 triptych 수치 타일
(3~6개, 그 이상은 표). 차트가 필요하면:

- 세션에 `dataviz` 스킬이 있으면 **차트 코드를 쓰기 전에** 로드해 색·형태
  규칙을 따른다.
- 차트는 **인라인 SVG**로 그린다(외부 차트 라이브러리 금지, JS 금지는 차트에도
  적용 — 정적 SVG만). 데이터가 크면 표를 병기해 접근성을 지킨다.

## Artifact 퍼블리시 (옵션)

로컬 파일이 기본값이다. **Artifact 도구가 세션에 있고** 사용자가 공유 URL을
원할 때만(`--artifact` 또는 명시 요청) 추가로 퍼블리시한다:

1. `artifact-design` 스킬을 먼저 로드한다(Artifact 규칙).
2. Artifact는 파일을 자체 스켈레톤으로 감싸므로 래퍼를 벗긴 사본을 만든다:
   `<!DOCTYPE html>`·`<html>`·`<head>`·`</head>`·`<body>` 태그와 `meta`를 제거,
   `<title>`은 Artifact `title` 파라미터로 옮기고, head의 `<style>`은 콘텐츠
   최상단으로 내린다. 테마 셀렉터·자기완결성은 이미 계약을 만족한다.
3. 원본 로컬 파일은 그대로 둔다 — 퍼블리시 사본은 임시 파일(scratchpad)로.

## 한계

- `check.mjs`는 정적 검사다: 렌더 품질(겹침·대비·rail 줄바꿈)은 못 잡는다.
  시각 품질은 브라우저 확인으로.
- md의 각주·중첩 복잡 표 등 특수 문법은 가장 가까운 HTML로 보수적으로 옮기고,
  애매하면 원문을 주석으로 남긴다.
- v1(GitHub 톤·JS TOC) 산출물은 재생성 대상이 아니다 — 모드 A 파생물은 소스
  md를 다시 렌더하면 자연히 v2로 온다.
