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
