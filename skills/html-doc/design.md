# html-doc 디자인 시스템

이 스킬의 모든 산출물이 **한 시스템으로 보이게** 하는 명세.
[template.html](template.html)의 CSS가 구현체이고, 이 문서는 그 어휘를
명시한다 — 토큰(색·폰트) + 컴포넌트 인벤토리 + 확장 규칙. 견본에 없는 상황을
만나면 즉흥으로 마크업을 만들지 말고 **여기서 찾아 스니펫을 복사**한다.

## 토큰

색은 전부 CSS 변수다. 라이트/다크 값이 쌍으로 정의돼 있으므로 **토큰을 쓰는
한 다크 테마는 공짜**다. 반대로 색 리터럴(`#hex`·`rgb()`)을 본문에 하드코딩하면
다크 테마가 조용히 깨진다 — 인라인 `style` 속성의 색 리터럴은
`check.mjs`(`inline-color`)가 반려한다.

| 토큰 | 라이트 | 다크 | 용도 |
| --- | --- | --- | --- |
| `--bg` | `#ffffff` | `#0d1117` | 페이지 바닥 |
| `--fg` | `#1f2328` | `#e6edf3` | 본문 텍스트 |
| `--muted` | `#59636e` | `#9198a1` | 보조 텍스트 — 메타·캡션·TOC·figcaption |
| `--border` | `#d1d9e0` | `#3d444d` | 괘선·테두리 전부 |
| `--accent` | `#0969da` | `#4493f8` | 링크·버전 배지·활성 TOC |
| `--surface` | `#f6f8fa` | `#151b23` | 면 — pre 배경·revlog·표 헤더 |
| `--code-bg` | `#f0f2f5` | `#1c2128` | 인라인 code 배경 |
| `--mark-bg` | `#fff8c5` | `#3a3000` | mark 하이라이트 |

폰트도 토큰이다: 산문 `var(--font-sans)`, 코드·다이어그램 `var(--font-mono)`
(둘 다 시스템 스택 + 한글 폴백 — 웹폰트 금지 철칙과 한 몸).

### 의미 토큰 — 패턴 CSS 블록과 함께 들어온다

template.html 기본엔 없고, 해당 패턴을 복사하면 CSS 블록에 포함돼 들어온다.
여러 패턴이 한 문서에 공존하면 정의가 중복되지만 **값이 같아 무해**하다.

| 토큰 | 의미 | 쓰는 패턴 |
| --- | --- | --- |
| `--actor-a/-b` (+`-soft`) | 두 주체/소속의 의미색 | sequence, architecture |
| `--ok` (+`-soft`) | 채택·안정·검증됨 | compare, states, stats |
| `--bad` (+`-soft`) | 기각·이탈·경고(심각) | compare, states, stats |
| `--hold` (+`-soft`) | 보류·과도기·주의 | compare, states, stats |

전부 라이트/다크 쌍으로 정의돼 있다 — 주제에 맞게 바꿔도 쌍은 유지한다.

## 규율

- **색·배경·테두리는 토큰만.** `var(--...)` 외의 색 지정 금지. 강조가
  필요하면 `<mark>`, `<b>`, `--accent` 안에서 해결한다.
- **컴포넌트를 만들기 전에 아래 인벤토리를 확인한다.** 있으면 스니펫을
  복사하고, 없으면 [확장 규칙](#확장-규칙)대로 토큰 참조 클래스를 추가한다.
- **구조(폭·간격·정렬)는 자유, 색은 부자유.** 레이아웃 조정은 일관성을 깨지
  않지만 색은 깬다.

## 컴포넌트 인벤토리

### 문서 헤더 — 제목 + 버전 배지 + 메타

```html
<header>
  <h1>문서 제목 <span class="badge">v0.1</span></h1>
  <p class="doc-meta">작성 2026-01-01 · 상태 초안</p>
</header>
```

### 개정 로그 — `details.revlog` (최신이 위)

```html
<details class="revlog">
  <summary>개정 로그</summary>
  <ul>
    <li><b>v0.2</b> (2026-01-02) — 무엇을·왜 한 줄.</li>
    <li><b>v0.1</b> (2026-01-01) — 최초 작성.</li>
  </ul>
</details>
```

### 섹션 — h2/h3 + 영문 kebab-case `id` (TOC·앵커가 사용)

```html
<section>
  <h2 id="goals">1. 목표와 비목표</h2>
  <h3 id="goals-in">목표</h3>
</section>
```

### 표 — 반드시 `.table-wrap`으로 감싼다 (가로 스크롤 격리)

```html
<div class="table-wrap">
  <table>
    <thead><tr><th>항목</th><th>값</th></tr></thead>
    <tbody><tr><td>…</td><td>…</td></tr></tbody>
  </table>
</div>
```

### 텍스트 다이어그램 — `figure > pre.diagram` + 캡션

```html
<figure>
  <pre class="diagram">
┌──────┐     ┌──────┐
│  a   │ ──▶ │  b   │
└──────┘     └──────┘</pre>
  <figcaption>D1. 캡션 한 줄.</figcaption>
</figure>
```

### 코드 블록 / 인라인 코드 / 코드 위치 인용

```html
<pre><code>const x = render(source);</code></pre>
<p>인라인은 <code>render()</code>, 위치 인용은
  <code class="cite">core/context/context.mjs:42</code>.</p>
```

### 인용·주석 블록 — `blockquote` (출처·부연·판단 유보)

```html
<blockquote><p>원문 인용이나 메타 코멘트.</p></blockquote>
```

### 강조 — `mark` (하이라이트) / `b` (굵게)

```html
<p>핵심 질문은 <mark>이 문장</mark>이다.</p>
```

### 파생물 표기 — `footer.derived` (모드 A 전용, check가 강제)

```html
<footer class="derived" data-derived-from="docs/src.md">
  이 HTML은 <code>docs/src.md</code>에서 생성된 파생물이다 (생성 2026-01-01,
  소스 커밋 abc1234). 내용 수정은 소스 md에서.
</footer>
```

### 고정 요소 (건드리지 않음)

테마 토글 버튼(`#theme-toggle`), TOC(`nav#toc`), 레이아웃 그리드(`.layout`)는
템플릿 래퍼 소속이다 — 지우지도, 재구현하지도 않는다.

## 패턴

블록 하나가 아니라 **여러 블록의 조립 골격**은 `patterns/`에 견본 문서로
등재한다. 견본 파일이 곧 복사 원본이다 — CSS와 마크업에 `:START…:END` 마커가
있어 그대로 들어낼 수 있고, 브라우저로 열면 데모 겸 사용법 문서다.

### 시퀀스 — 두 주체의 시간순 왕복 ([patterns/sequence.html](patterns/sequence.html))

- **언제**: API 왕복·훅 ↔ 하네스 이벤트·미러 ↔ 서버 동기화처럼 두 주체가
  시간 순서로 주고받는 흐름을 **내용물까지** 보여줄 때. 구조·관계만 필요하면
  `pre.diagram`이 더 싸다.
- **어떻게**: 견본의 `시퀀스 패턴 CSS:START…END`를 문서 `<style>` 끝에,
  `마크업:START…END`를 본문에 복사해 내용을 교체한다. 구성 블록 6종 =
  `actors`(주체 카드, 상단 고정) · `wire`(화살표+라벨 필) · `payload`(요지
  스택 + `rawbox` 접힌 원문) · `local`(한쪽 내부 처리, 점선) · `edge`(시작/끝
  경계) · `keys`(요점 카드 그리드). 좌표 계산이 없는 순수 마크업이다.
- **규칙**: 액터 색 토큰(`--actor-a/-b` + `-soft`)은 주제에 맞게 바꿔도 되나
  **라이트/다크 쌍은 유지**. 다이어그램 내부에 h2/h3 금지(`.card-title`
  사용 — heading id·TOC 규율과 충돌). 색이 의미를 가지면 본문에 범례를 먼저
  선언. 원문 데이터는 요지로 재작성하되 `rawbox`에 보존.

### 아키텍처 — 경계·컴포넌트·흐름 ([patterns/architecture.html](patterns/architecture.html))

- **언제**: 계층·경계·파이프라인 구조 — 네트워크 경계 안 컴포넌트, 층간
  데이터 흐름, 단계 처리 라인. **임의 그래프(얽힌 대각 엣지)는 불가** —
  그건 `pre.diagram`으로 후퇴.
- **블록**: `zone`(경계, 중첩·`tone-a/b` 소속색) · `node`(컴포넌트,
  `hi` 강조) · `pipe`(존 안 가로 단계) · `flow`(존 사이 수직 화살표+라벨).

### 비교/결정 — 대안 카드 + 판정 + 결정 기록 ([patterns/compare.html](patterns/compare.html))

- **언제**: 설계 문서의 대안 검토 — 옵션 2~4개 + 채택/기각/보류 + 날짜 박힌
  결정 기록. 기준이 여러 축이면 기준 표 병기.
- **블록**: `compare`(카드 그리드) · `verdict`(`v-ok/v-bad/v-hold`) ·
  `pl`(+/− 목록) · `decision`(콜아웃 — **날짜·근거 필수**).

### 상태 전이 — 상태 필 + 전이 표 ([patterns/states.html](patterns/states.html))

- **언제**: 상태 몇 개와 전이 규칙으로 정의되는 대상(신뢰 티어·라이프사이클).
  **스트립 = 주 경로 요약, 전이 표 = 진실원** — 분기·역행은 표에만. 얽힌
  상태기계는 패턴 밖.
- **블록**: `states`(필 스트립, `initial` 점선·성격색 `s-ok/s-hold/s-bad`) ·
  `tr`(전이 라벨) + 전이 표(from/to/트리거/가드).

### 타임라인 — 시간축 이벤트 ([patterns/timeline.html](patterns/timeline.html))

- **언제**: 프로젝트 경과·인시던트 재구성 등 서사적 이벤트 나열. 수십 개면
  표가 낫다.
- **블록**: `timeline`(세로선) · `tl-item`(`when/what/detail`, `major` 강조 —
  전환점에만).

### 스탯 타일 — 핵심 수치 요약 ([patterns/stats.html](patterns/stats.html))

- **언제**: 리포트(모드 C) 머리에 대표 수치 4~6개. 그 이상이면 표로.
- **블록**: `stats`(그리드) · `stat`(`num/label/sub`, `hi` 하나만). `sub` 색은
  데이터 계열이 아니라 **판정**(good/warn/crit) — 수치엔 색을 칠하지 않는다.

## 확장 규칙

인벤토리에 없는 블록이 필요할 때만, `<style>` 끝에 **토큰만 참조하는
클래스**를 추가한다. 예 — 콜아웃 박스:

```html
<style>
.callout {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 8px;
  padding: 0.75rem 1rem;
}
</style>
```

색 리터럴이 필요하다고 느껴지면 대부분 토큰 선택이 잘못된 것이다 — 면은
`--surface`, 선은 `--border`, 강조는 `--accent`/`--mark-bg`로 되돌아간다.
데이터 시각화(모드 C)처럼 계열 색이 정말 필요한 경우만 예외이며, 그때도
`<style>`의 클래스로 정의하고 라이트/다크 두 값을 모두 지정한다
(인라인 `style` 색 리터럴은 check가 반려한다).
