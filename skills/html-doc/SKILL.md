---
name: html-doc
argument-hint: "[소스.md | 주제] [--artifact]"
description: >-
  설계 문서·리포트·분석 산출물을 self-contained 단일 HTML 파일로 만든다.
  세 가지 모드: 기존 md 문서 → HTML 렌더(내용 재작성 금지), 새 설계문서를
  HTML로 직접 작성, 범용 산출물(리포트·비교표·시각화 페이지). 외부 요청 0
  (사내 오프라인·Artifact CSP 겸용), 라이트/다크 테마, sticky TOC, 인쇄 CSS를
  template.html 스켈레톤으로 보장하고 check.mjs로 기계 검증한다. 사용자가
  문서·산출물을 "HTML로 만들어/변환해/렌더해/뽑아줘"라고 하면 발동한다.
  출력은 로컬 파일이 기본, Artifact 퍼블리시는 옵션.
---

# html-doc

설계 문서나 분석 산출물을 **self-contained 단일 HTML 파일**로 만드는 절차.
매번 즉흥적으로 만들 때 흔들리는 것들 — 자기완결성(오프라인·CSP), 라이트/다크,
TOC, 인쇄, 문서 관례 — 을 이 폴더의 `template.html`이 스켈레톤으로 고정하고,
`check.mjs`가 렌더 후 기계로 검증한다.

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
2. **테마 양방향.** 기본은 OS 설정(`prefers-color-scheme`), 수동 토글은
   `:root[data-theme="dark"|"light"]` 오버라이드 — Artifact 뷰어 계약과 동일한
   셀렉터라 퍼블리시해도 그대로 동작한다. 템플릿의 토글 버튼·저장 로직을
   지우지 않는다.
3. **언어.** 산문은 한글, 코드·식별자·heading `id`는 영어(kebab-case).
4. **가로 스크롤은 컨테이너 안에서만.** 표는 `.table-wrap`, 코드·다이어그램은
   `pre`가 스스로 스크롤한다. `body`가 가로로 흐르면 안 된다.
5. **h2/h3엔 저작 시점에 `id`를 부여한다.** TOC와 앵커가 이 `id`를 쓰므로
   재생성해도 앵커가 안정적이다. JS로 자동 생성하지 않는다.
6. **시각 블록은 패턴 결정표로 고른다.** 전부 좌표 계산 없는 순수 마크업 —
   견본은 `patterns/`에 있고 상세는 [design.md §패턴](design.md).

   | 표현할 것 | 패턴 |
   | --- | --- |
   | 두 주체의 시간순 왕복 (API·이벤트·프로토콜) | [sequence](patterns/sequence.html) |
   | 계층·경계·파이프라인 구조 | [architecture](patterns/architecture.html) |
   | 대안 비교 + 채택/기각 결정 | [compare](patterns/compare.html) |
   | 상태와 전이 규칙 | [states](patterns/states.html) |
   | 시간축 이벤트 서사 | [timeline](patterns/timeline.html) |
   | 리포트 머리 핵심 수치 4~6개 | [stats](patterns/stats.html) |
   | 그 외 구조·관계 (얽힌 그래프 포함) | `pre.diagram` (ASCII) |
   | 확신 없음 / 데이터가 본체 | 표 (`.table-wrap`) |

   mermaid 라이브러리 임베드는 금지(수 MB) — Artifact **전용** 산출물에서만
   뷰어 네이티브 mermaid를 써도 된다.
7. **인라인 JS는 허용하되 네트워크 호출 금지.** `fetch`/`XHR`/`WebSocket`을
   쓰지 않는다. `check.mjs`는 정적 검사라 이건 못 잡는다 — 스스로 지킨다.
8. **디자인은 [design.md](design.md)의 토큰·컴포넌트 인벤토리를 따른다.**
   색·배경·테두리는 `var(--...)` 토큰만 — 인라인 `style`의 색 리터럴
   (`#hex`·`rgb()`)은 check가 반려한다(`inline-color`). 새 블록이 필요하면
   인벤토리에서 먼저 찾고, 없으면 토큰만 참조하는 클래스로 추가한다.

## 공통 절차

1. 이 폴더의 `template.html`을 출력 경로로 **복사**한다.
2. `<!-- CONTENT:START -->`와 `<!-- CONTENT:END -->` 사이의 예시를 실제 내용으로
   교체하고, `<title>` 포함 `{{...}}` 플레이스홀더를 전부 채운다. 마커 밖의
   래퍼(CSS·TOC·토글·스크립트)는 유지한다. 블록이 필요하면
   [design.md](design.md) 인벤토리의 스니펫을 복사하고, 스타일을 추가할 땐
   확장 규칙(토큰만 참조하는 클래스)을 따른다.
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

- 매핑: heading(§ 번호 그대로, `id` 부여) / 코드펜스 → `pre><code` / 언어 없는
  펜스에 box-drawing 문자(┌─│▶ 등)가 있으면 → `pre.diagram` / 표 →
  `.table-wrap>table` / 인용 블록 → `blockquote`. md 개정 로그 인용문은
  `details.revlog`로 접는다. md의 `---`(hr)가 바로 다음 h2와 붙으면 괘선이
  이중으로 보인다 — 템플릿 CSS가 `hr + section > h2:first-child`로 잡아주지만,
  h2 직전의 hr은 애초에 생략해도 된다(h2가 자체 상단 괘선을 그린다).
- **출력 경로 = 소스 옆 same-basename**: `docs/foo-design.md` →
  `docs/foo-design.html`.
- **파생물 표기 (check가 `--derived`로 강제):** 문서 말미에

  ```html
  <footer class="derived" data-derived-from="<소스 상대경로>">
    이 HTML은 <code><소스 상대경로></code>에서 생성된 파생물이다
    (생성 <YYYY-MM-DD>, 소스 커밋 <git log -1 --format=%h -- 소스>).
    내용 수정은 소스 md에서.
  </footer>
  ```

  소스가 git 레포 밖이면 커밋 해시는 생략하고 그 사실을 적는다.

- **덮어쓰기 규칙**: 출력 경로에 파일이 이미 있으면 열어본다 —
  `data-derived-from`이 있으면 이 스킬의 재생성 산출물이니 그냥 덮어쓰고,
  없으면(손으로 만든 파일) 사용자에게 확인받는다.

## 모드 B — 새 설계문서를 HTML로

md 설계문서 관례를 HTML에서 그대로 유지한다(템플릿 예시 콘텐츠가 이 골격):

- `h1` 제목 + **버전 배지**(`span.badge`, v0.1부터) + 작성일(`p.doc-meta`)
- **개정 로그** `details.revlog` — 최신 항목을 위로, "무엇을·왜"를 한 줄로
- `0. 한 줄 요약` 섹션부터 시작, 이후 § 번호 섹션(`1. 목표와 비목표`, …)
- 코드 인용은 `<code class="cite">파일경로:줄번호</code>`
- HTML 자신이 진실원이므로 derived footer는 **쓰지 않는다**. 개정하면 배지
  버전을 올리고 개정 로그에 항목을 추가한다.

## 모드 C — 범용 산출물

리포트·비교·대시보드류. 문서 골격(§·개정 로그)은 필요한 만큼만 가져가되
철칙은 전부 적용된다. 차트가 필요하면:

- 세션에 `dataviz` 스킬이 있으면 **차트 코드를 쓰기 전에** 로드해 색·형태
  규칙을 따른다.
- 차트는 **인라인 SVG**로 그린다(외부 차트 라이브러리 금지). 데이터가 크면
  표를 병기해 접근성을 지킨다.

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

- `check.mjs`는 정적 검사다: 인라인 JS의 런타임 네트워크 호출, 렌더 품질
  (겹침·대비)은 못 잡는다. 시각 품질은 브라우저 확인으로.
- md의 각주·중첩 복잡 표 등 특수 문법은 가장 가까운 HTML로 보수적으로 옮기고,
  애매하면 원문을 주석으로 남긴다.
