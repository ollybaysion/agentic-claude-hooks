# html-doc 디자인 시스템 (v2 — editorial)

이 스킬의 모든 산출물이 **한 시스템으로 보이게** 하는 명세.
[template.html](template.html)의 CSS가 구현체이고, 이 문서는 그 어휘를
명시한다 — 토큰(색·폰트) + 컴포넌트 인벤토리 + 확장 규칙. 견본에 없는 상황을
만나면 즉흥으로 마크업을 만들지 말고 **여기서 찾아 스니펫을 복사**한다.

기조는 editorial: 웜 그레이 바탕 위에 테라코타 액센트 하나, 라벨·번호·캡션은
전부 모노스페이스 대문자, 인용만 serif. **문서에 JS를 넣지 않는다** — TOC는
정적 rail, 테마는 CSS만으로 동작한다 (check가 `no-script`로 강제).

## 토큰

색은 전부 CSS 변수다. 라이트/다크 값이 쌍으로 정의돼 있으므로 **토큰을 쓰는
한 다크 테마는 공짜**다. 색 리터럴을 본문에 하드코딩하면 다크가 조용히
깨진다 — 인라인 `style` 속성의 색 리터럴은 `check.mjs`(`inline-color`)가
반려한다.

| 토큰 | 라이트 | 다크 | 용도 |
| --- | --- | --- | --- |
| `--bg` | `#EEF0F1` | `#0F1417` | 페이지 바닥 (웜 그레이) |
| `--surface` | `#F9FAFA` | `#161D21` | 카드·셀 면 |
| `--sunken` | `#E5E9EA` | `#12181B` | 코드·다이어그램 배경 — bg보다 가라앉음 |
| `--ink` | `#14181B` | `#E4E9EB` | 본문 텍스트 |
| `--ink-2` | `#47535B` | `#A3B0B7` | 보조 본문 — lede·설명·카드 본문 |
| `--ink-3` | `#6E7C85` | `#77858D` | 메타·라벨·캡션 |
| `--line` | `#D2D8DB` | `#273138` | 주 괘선 |
| `--line-soft` | `#E2E6E8` | `#1E272C` | 약 괘선 — 행 구분·코드 테두리 |
| `--accent` | `#A8451A` | `#E38C55` | 테라코타 — 링크·번호·강조. 문서당 이것 하나 |
| `--accent-bg` | `rgba(168,69,26,.09)` | `rgba(227,140,85,.13)` | 액센트 면 |
| `--blue` | `#3F6180` | `#83A9C6` | 보조 의미색 — 관문·상태 라벨 |
| `--blue-bg` | `rgba(63,97,128,.10)` | `rgba(131,169,198,.13)` | 블루 면 |

테마 캐스케이드: 라이트 값을 `:root`에, 다크 값을
`@media (prefers-color-scheme: dark)`의 `:root`에, 그리고
`:root[data-theme="dark"]` / `:root[data-theme="light"]` **둘 다**에 명시적
오버라이드로 다시 정의한다 — 속성 셀렉터의 높은 특이도가 media 블록을 이겨서
뷰어 수동 토글이 양방향으로 동작한다 (Artifact 뷰어 계약과 동일).

폰트는 3역이다: 산문 `var(--sans)` · 라벨/번호/eyebrow/캡션
`var(--mono)`(대문자 + letter-spacing) · 인용 전용 `var(--serif)`(Georgia).
전부 시스템 스택 + 한글 폴백 — 웹폰트 금지 철칙과 한 몸. 레이아웃 상수:
`--measure: 34rem`(산문 폭) · `--rail: 13.5rem`(TOC 레일) · 페이지 66rem.
한글 조판: `word-break: keep-all`, 제목 `text-wrap: balance`.

## 규율

- **색·배경·테두리는 토큰만.** `var(--...)` 외의 색 지정 금지. 강조는
  `<strong>`·`--accent` 안에서 해결한다.
- **컴포넌트를 만들기 전에 아래 인벤토리를 확인한다.** 있으면 스니펫을
  복사하고, 없으면 [확장 규칙](#확장-규칙)대로 토큰 참조 클래스를 추가한다.
- **구조(폭·간격·정렬)는 자유, 색은 부자유.** 레이아웃 조정은 일관성을 깨지
  않지만 색은 깬다.
- **모노 라벨은 정보일 때만.** eyebrow·번호·tag는 실제 분류·순서를 담을 때
  쓴다 — 장식용 넘버링은 넣지 않는다.

## 컴포넌트 인벤토리

### masthead — eyebrow → h1(+.en) → standfirst → credits

```html
<header class="masthead">
  <p class="eyebrow"><span class="mark">◆</span> 프로젝트 · 문서 종류 · v0.1</p>
  <h1>문서 제목 <span class="en">mono subtitle in english</span></h1>
  <p class="standfirst">서두 요약 한 문단 — 이 문서가 답하는 것.</p>
  <div class="credits">
    <span>작성 · 2026-01-01</span>
    <span>짝 문서 · <a href="https://example.com">링크</a></span>
  </div>
</header>
```

### 개정 로그 — `details.revlog` (모드 B, masthead 안 credits 아래)

```html
<details class="revlog">
  <summary>개정 로그</summary>
  <ul>
    <li><b>v0.2</b> (2026-01-02) — 무엇을·왜 한 줄.</li>
    <li><b>v0.1</b> (2026-01-01) — 최초 작성.</li>
  </ul>
</details>
```

### rail — 정적 TOC (링크·id를 손으로 맞춘다, check가 `rail-anchor`로 검증)

```html
<nav class="rail" aria-label="목차">
  <ol>
    <li><a href="#s1"><span class="num">01</span> 섹션 제목</a></li>
    <li><a href="#s2"><span class="num">02</span> 섹션 제목</a></li>
  </ol>
</nav>
```

### 섹션 — `section#s번호` + `.sec-head` (check가 `section-id`로 검증)

```html
<section id="s1">
  <div class="sec-head"><span class="num">01</span><h2>섹션 제목</h2></div>
  <p class="lede">섹션 도입 요지.</p>
</section>
```

### 인라인 칩 — `.k` (식별자·경로·코드 인용 겸용, 맨 `code`도 같은 모양)

```html
<p>식별자는 <span class="k">coverage-core.mjs</span>, 위치 인용은
  <span class="k">core/context.mjs:42</span>.</p>
```

### 코드 블록 / ASCII 다이어그램 폴백

```html
<pre class="code">const x = render(source);</pre>
<pre class="diagram">┌──────┐     ┌──────┐
│  a   │ ──▶ │  b   │
└──────┘     └──────┘</pre>
```

### 표 — 반드시 `.table-scroll`로 감싼다 (check가 `table-scroll`로 강제)

```html
<div class="table-scroll">
  <table class="picker">
    <thead><tr><th>항목</th><th>값</th></tr></thead>
    <tbody><tr><td>…</td><td>…</td></tr></tbody>
  </table>
</div>
```

### 결정 콜아웃 — `.decision` (날짜·근거 필수)

```html
<div class="decision">
  <div class="d-label">결정 · 2026-01-01</div>
  무엇을 결정했고 왜 — "무엇"만이 아니라 "왜"가 기록의 가치다.
</div>
```

### 인용 — `blockquote` (serif 이탤릭 + cite. 인용 전용 — 결정 기록은 .decision)

```html
<blockquote>
  <p>원문에서 가져온 문장.</p>
  <cite>출처 — 무엇의 몇 절</cite>
</blockquote>
```

### 순서 있는 단계 — `.steps` (01 카운터 자동. 실제 순서가 있을 때만)

```html
<ol class="steps">
  <li><div><b>단계 제목</b><span>설명 한 줄.</span></div></li>
  <li><div><b>다음 단계</b><span>설명.</span></div></li>
</ol>
```

### 순서 없는 체크리스트 — `.rules` (마크 = 실제 식별자(R1·F2)나 ◆)

```html
<ul class="rules">
  <li><span class="mark">R1</span><div>
    <b>규칙 제목 <span class="state">v0.2 변경</span></b>
    <span>설명.</span></div></li>
</ul>
```

### 목록 · 푸터

```html
<ul class="plain"><li>일반 목록</li></ul>
<footer>
  <span>문서 이름 · v0.1</span>
  <span>짝 문서 · <a href="https://example.com">링크</a></span>
</footer>
```

### 파생물 표기 — `footer.derived` (모드 A 전용, check가 강제)

```html
<footer class="derived" data-derived-from="docs/src.md">
  이 HTML은 <span class="k">docs/src.md</span>에서 생성된 파생물이다
  (생성 2026-01-01, 소스 커밋 abc1234). 내용 수정은 소스 md에서.
</footer>
```

## 패턴

블록 하나가 아니라 **여러 블록의 조립 골격**은 `patterns/`에 견본 문서로
등재한다. 견본 파일이 곧 복사 원본이다 — CSS와 마크업에 `:START…:END` 마커가
있어 그대로 들어낼 수 있고, 브라우저로 열면 데모 겸 사용법 문서다.

### flow — 파이프라인·경로 ([patterns/flow.html](patterns/flow.html))

- **언제**: 데이터가 왼→오른쪽으로 흐르는 단계·경로. 분기는 `branch`,
  되돌이 하나까지는 `arrow.back`. **임의 그래프(얽힌 엣지)는 불가** —
  `pre.diagram`으로 후퇴.
- **블록**: `diagram > flow` · `node`(기본/`io` 점선/`lead` 테라코타/`gate`
  블루) · `arrow` · `branch` · `caption`.

### versus — 2안 대칭 대비 ([patterns/versus.html](patterns/versus.html))

- **언제**: 정확히 두 대상 — 두 전략·두 실패 모드·신구 방식. 카드 두 장이
  같은 골격(tag → h4 → 설명 → dl)을 공유한다. 결론은 카드 밖 `.decision`으로.
- **블록**: `versus` · `tag` · `h4` · `.who`(강조) · `dl`(대조 행 — 양쪽 같은
  라벨·순서).

### triptych — 3열 카드 ([patterns/triptych.html](patterns/triptych.html))

- **언제**: ① 대안 3안 검토(채택안 `pick` 강조 + `.decision` 결론) ② 리포트
  머리 대표 수치 타일(`h4.num`). 2안이면 versus, 4안+이면 표, 수치 7개+면 표.
- **블록**: `triptych` · `zone`(`alt` 회색) · `h4`(`.num` 수치 변형) · `pick`.

### sequence — 두 주체의 시간순 왕복 ([patterns/sequence.html](patterns/sequence.html))

- **언제**: API 왕복·훅 ↔ 하네스처럼 두 주체가 주고받는 흐름을 **내용물까지**
  보여줄 때. 구조만 필요하면 flow가 더 싸다.
- **블록 6종**: `actors` · `wire`(to-b/to-a) · `payload`(stack + `rawbox` 접힌
  원문) · `local`(한쪽 내부 처리, 점선) · `edge` · `keys`. 액터 색 토큰
  `--actor-a/-b`(+`-soft`)는 주제에 맞게 바꿔도 되나 **라이트/다크 쌍 유지**.
- **규칙**: 다이어그램 내부에 heading 금지(`.card-title` 사용). 색이 의미를
  가지면 본문에 범례 먼저.

## 확장 규칙

인벤토리에 없는 블록이 필요할 때만, `<style>` 끝에 **토큰만 참조하는
클래스**를 추가한다. 예 — 경고 콜아웃:

```html
<style>
.warn-callout {
  background: var(--blue-bg);
  border-left: 2px solid var(--blue);
  border-radius: 0 4px 4px 0;
  padding: 0.9rem 1.15rem;
}
</style>
```

색 리터럴이 필요하다고 느껴지면 대부분 토큰 선택이 잘못된 것이다 — 면은
`--surface`/`--sunken`, 선은 `--line`, 강조는 `--accent`/`--blue`로 되돌아간다.
데이터 시각화(모드 C)처럼 계열 색이 정말 필요한 경우만 예외이며, 그때도
`<style>`의 클래스로 정의하고 라이트/다크 두 값을 모두 지정한다
(인라인 `style` 색 리터럴은 check가 반려한다).
