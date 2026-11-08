# html-doc 디자인 시스템 (v3 — 블로그 글 꼴)

이 문서는 [template.html](template.html) 의 CSS 가 쓰는 어휘를 적는다. 토큰 · 글자 크기 ·
기둥 숫자 · 부품마다 마크업 예 하나가 있다. 견본에 없는 상황이 오면 여기서 부품을 찾아
마크업을 복사한다.

기조는 블로그 글이다. 흰 바탕에 청록 강조색 하나를 쓴다. 제목은 명조, 본문은 고딕이다.
글은 짧게 쓰고 그림이 설명을 맡는다. 차례는 정적 `nav`, 테마는 CSS 가 맡는다.

## 토큰

색은 모두 CSS 변수다. 라이트 값은 `:root` 에, 다크 값은 두 자리에 같은 이름으로 둔다:
`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` 와
`:root[data-theme="dark"] { … }`. 앞의 것은 OS 설정을, 뒤의 것은 뷰어 토글을 따른다.
`check.mjs` 의 `theme-dark-tokens` 가 두 자리의 이름을 맞춰 본다.

| 토큰 | 라이트 | 다크 | 쓰는 곳 |
| --- | --- | --- | --- |
| `--bg` | `#ffffff` | `#11161a` | 페이지 바닥 |
| `--surface` | `#ffffff` | `#11161a` | 카드 면 · svg-diagram 상자 면 · 선 라벨 테두리 |
| `--sunken` | `#f1f6f5` | `#172126` | 그림 패널 · 인용 상자 · 표 머리 · 인라인 코드 |
| `--warm` | `#fdf6e6` | `#221f17` | 체크 목록 상자 |
| `--ink` | `#17202a` | `#eef3f3` | 제목 · 굵은 글 |
| `--ink-2` | `#4b5560` | `#b9c3c7` | 본문 |
| `--ink-3` | `#66717b` | `#8a979c` | 라벨 · 메타 · 그림 설명 |
| `--line` | `#e3e8ea` | `#263238` | 괘선 |
| `--line-soft` | `#eef2f3` | `#1c262b` | 옅은 괘선 · svg-diagram 모눈 |
| `--accent` | `#0f766e` | `#5cc9b8` | 링크 · 번호 배지 · 강조. 문서에 하나 |
| `--accent-bg` | `#d7efeb` | `#173a36` | 강조 면 · 결정 번호 · 차례 번호 |
| `--on-accent` | `#ffffff` | `#0c1d1b` | 강조 면 위 글자 |
| `--blue` | `#2f6690` | `#8db8d8` | 보조 의미 — svg-diagram 분기 상자 · 되돌아가는 선 |
| `--blue-bg` | `#e3eef6` | `#172a36` | 보조 면 |
| `--coral` | `#c4553e` | `#e57a62` | 번호 흐름(`ol.flows`) 배지 |
| `--on-coral` | `#ffffff` | `#1a0f0c` | 산호 배지 위 글자 |
| `--code-bg` · `--code-ink` | `#142028` · `#dce8ea` | `#0b1014` · `#dce8ea` | 코드 블록 |
| `--code-k` · `--code-s` · `--code-c` | `#7fd8c9` · `#f7c873` · `#8a9ea4` | 같음 · 같음 · `#7e9298` | 코드의 키 · 글 · 주석 |

svg-diagram 의 `doc` 스타일은 `--bg · --surface · --sunken · --ink · --ink-2 · --ink-3 · --line ·
--line-soft · --accent · --accent-bg · --blue · --blue-bg · --sans · --mono` 를 읽는다. 이 이름은
그대로 둔다.

글꼴은 셋이다. 모두 시스템 글꼴이다.

| 토큰 | 쌓기 | 쓰는 곳 |
| --- | --- | --- |
| `--sans` | `system-ui`, Apple SD Gothic Neo, Noto Sans CJK KR, Malgun Gothic | 본문 · 라벨 · 그림 |
| `--serif` | Noto Serif CJK KR, AppleMyungjo, Nanum Myeongjo, Batang | 제목 · 절 제목 · 큰 인용 · 결정 번호 |
| `--mono` | `ui-monospace`, D2Coding, Noto Sans Mono CJK KR, Menlo, Consolas | 코드 · 식별자 |

## 글자 크기

제목은 본문의 4 배 이상이다. `check.mjs` 의 `type-ratio` 가 미디어 밖 `h1` · `body` 규칙의
px · rem 값을 나눠 본다. `clamp()` 처럼 읽지 못하는 값은 경고로 알린다.

| 자리 | 넓은 화면 | 760 px 이하 | 굵기 |
| --- | --- | --- | --- |
| 라벨 · 메타 · 좌표 줄 · 표 머리 | 12 px, 자간 .06em | 같음 | 700 |
| 그림 설명 | 13 px | 같음 | 400 |
| 차례 | 14 px | 같음 | 400 |
| 본문 | 17 px | 16 px | 400 |
| 부제 · 첫 문단(`.lead`) | 19 px | 같음 | 400 · 500 |
| 큰 인용 | 30 px | 22 px | 600 |
| 절 제목 H2 | 32 px | 26 px | 600 |
| 제목 H1 | 72 px | 52 px | 600 |

## 기둥

| 이름 | 값 | 뜻 |
| --- | --- | --- |
| `--measure` | 680 px | 글 폭. 절의 자식은 모두 이 폭으로 가운데에 선다 |
| `--wide` | 920 px | 넓은 폭. `.wide` 를 붙인 그림 · 코드 · 패턴 |
| 차례 | 200 px | 1100 px 이상에서 왼쪽에 붙어 따라온다(`position: sticky`) |
| 바깥 여백 | 16 px | 폰 폭에서도 같다 |
| 절 사이 | 80 px | `h2` 위 여백. 폰은 64 px |

1100 px 이상에서 본문 기둥은 화면 가운데에 선다. 차례 자리가 모자라면 기둥이 오른쪽으로
밀린다. 1100 px 아래에서 차례는 머리 밑 접이(`details.toc-m`)로 바뀐다.

부품 규칙은 위아래 여백(`margin-block`)만 정한다. 가로 여백은 기둥 규칙
(`main section > *`)이 정한다.

## 규율

- 색 · 배경 · 테두리는 토큰으로만 쓴다. 인라인 `style` 의 색 글자와 SVG `fill="#…"` 는
  `check.mjs` 의 `inline-color` 가 막는다.
- 선은 실선이다. 구분은 색 · 면 · 굵기로 한다. `dashed` · `dotted` · `stroke-dasharray` 는
  `no-dash` 가 막는다.
- 부품을 새로 만들기 전에 아래 목록을 본다. 목록에 없으면 토큰만 쓰는 class 를 `<style>`
  끝에 더한다.
- 번호 배지는 실제 순서나 그림 번호일 때만 쓴다.

## 부품

### 머리 — 좌표 줄 → 제목 → 부제 → 메타

넷만 둔다. 순서는 `check.mjs` 의 `head` · `head-order` 가 본다. 좌표 줄의 `path` 는
대분류 › 중분류 › 이 문서, `rel` 은 관련 문서다. 링크가 있으면 `a`, 없으면 `span` 으로 쓴다.

```html
<header class="wrap head">
  <nav class="coord" aria-label="문서 좌표">
    <span class="path"><span>fdc-agent</span> › <span>AKG</span> › <span aria-current="page">설계 문서</span></span>
    <span class="rule" aria-hidden="true"></span>
    <span class="rel"><small>관련</small><a href="#next">JSON 스펙 v0.10.0</a></span>
  </nav>
  <h1 id="top">에이전트가 읽는 지식, 한&nbsp;곳에서 맞다고 정한다</h1>
  <p class="sub">agent-knowledge-governance 설계 · v0.4.7&nbsp;초안</p>
  <p class="meta"><span>2026-07-17</span><span>읽는 데 6 분</span></p>
</header>
```

### 차례 — 고정 `nav.toc` + 접이 `details.toc-m`

같은 목록을 두 번 쓴다. 링크와 `section id` 는 손으로 맞춘다(`anchor` 가 본다).
`:target` 강조는 `s1` ~ `s9` 까지 template 에 있다. 절이 아홉을 넘으면 그 줄을 늘린다.

```html
<div class="wrap toc-mw">
  <details class="toc-m">
    <summary>차례 · 2 절</summary>
    <ol class="toc-list">
      <li><a href="#s1"><span class="no">1</span><span>지금 무엇이 곤란한가</span></a></li>
      <li><a href="#s2"><span class="no">2</span><span>한 문장으로</span></a></li>
    </ol>
    <p class="toc-next"><a href="#next">다음에 읽을 글<span aria-hidden="true">→</span></a></p>
  </details>
</div>
<div class="layout">
  <nav class="toc" aria-label="차례">
    <p class="toc-k">차례</p>
    <ol class="toc-list">…같은 목록…</ol>
  </nav>
  <div class="content"><main>…절…</main></div>
</div>
```

### 절 머리 — `section#sN > h2` + 첫 문단

```html
<section id="s1">
  <h2>지금 무엇이 곤란한가</h2>
  <p class="lead">에이전트는 프롬프트에 맞는 지식 문서를 받아서 답한다.</p>
</section>
```

### 그림 카드 — `figure > .panel` + 번호 배지 설명

패널 안에는 svg-diagram 조각을 넣는다. 넓은 그림은 `figure.wide` 로 둔다.

```html
<figure class="wide">
  <div class="panel"><svg class="d s-doc" …>…</svg></div>
  <figcaption><span class="no">2</span><span>아키텍처</span></figcaption>
</figure>
```

### 표 — `.table-scroll` 안에 (`table-scroll` 이 본다)

```html
<div class="table-scroll">
  <table>
    <thead><tr><th>인스턴스</th><th>우선순위</th></tr></thead>
    <tbody><tr><td class="id">msg-format</td><td><span class="pill">65</span></td></tr></tbody>
  </table>
</div>
```

### 큰 인용 상자 — `.pull`

한 문장으로 줄인 접근을 크게 보인다. 식 한 줄은 아래 `pull-code` 에 둔다.

```html
<div class="pull">
  <blockquote><p>문서의 원본은 JSON&nbsp;이다.</p></blockquote>
  <p class="pull-code"><code>render(json) === md</code></p>
</div>
```

### 번호 흐름 — `ol.flows`

```html
<ol class="flows">
  <li><b>읽기.</b> 키워드는 늘 로컬 미러에서 찾는다.</li>
</ol>
```

### 결정 카드 — `ol.dec`

카드 하나 = 제목 한 줄 + 까닭 한 줄.

```html
<ol class="dec">
  <li><b>저장소는 git 레포가 전부다.</b> 변경 하나 = 커밋 하나.</li>
</ol>
```

### 체크 목록 — `.note > ul.checks`

`li.done` 은 정한 것이다. 칸이 채워지고 `정함` 꼬리표가 붙는다. 빈 칸은 남은 것이다.

```html
<div class="note">
  <ul class="checks">
    <li class="done"><span class="tag">정함</span>레포 이름 = akg.</li>
    <li>호스팅: 사내 서버 사양 · HTTPS 프록시.</li>
  </ul>
</div>
```

### 코드 블록 — `pre.code`

`span.k` 는 키, `span.s` 는 글, `span.c` 는 주석이다.

```html
<pre class="code">{ <span class="k">"tier"</span>: <span class="s">"inferred"</span> }</pre>
```

### 다음에 읽을 글 — `nav.next#next`

좌표 줄의 관련 문서와 같은 목록이다.

```html
<nav class="next" id="next" aria-label="다음에 읽을 글">
  <h2>다음에 읽을 글</h2>
  <ul><li><a href="#top">JSON 스펙 v0.10.0<span aria-hidden="true">→</span></a></li></ul>
</nav>
```

### 파생물 표기 — `footer.derived` (md 렌더 모드, `--derived` 가 본다)

```html
<footer class="derived" data-derived-from="docs/src.md">
  이 HTML 은 <code>docs/src.md</code> 에서 만든 파생물이다(2026-11-08, 원본 커밋 abc1234).
  내용은 원본 md 에서 고친다.
</footer>
```

## 패턴

여러 부품을 묶은 뼈대는 `patterns/` 에 견본 문서로 둔다. 견본 파일이 복사 원본이다.
CSS 와 마크업에 `START … END` 표시가 있다.

| 패턴 | 언제 | 파일 |
| --- | --- | --- |
| versus | 정확히 두 대상을 맞세운다. 두 카드가 같은 dl 라벨을 같은 순서로 쓴다 | [patterns/versus.html](patterns/versus.html) |
| triptych | 대안 세 안(`pick` 하나) 또는 대표 수치 셋(`h3.num`) | [patterns/triptych.html](patterns/triptych.html) |

흐름 · 순서 · 구조 그림은 svg-diagram 이 그린다. [SKILL.md](SKILL.md) 의 그림 결정표를 본다.
