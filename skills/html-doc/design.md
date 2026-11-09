# html-doc 디자인 시스템 (v4 — 시안 페이지 꼴)

이 문서는 [template.html](template.html) 의 CSS 가 쓰는 어휘를 적는다. 토큰 · 글자 크기 ·
기둥 숫자 · 부품마다 마크업 예 하나가 있다. 견본에 없는 상황이 오면 여기서 부품을 찾아
마크업을 복사한다.

기조는 첫 선택 데이터 시안 페이지(2026-11-10)의 쪽 꾸밈이다. 바탕은 클린룸 회청, 강조색은
노광실(yellow room) 노랑 하나다. 노랑은 면 · 표지 · 밑줄 · 배지에만 쓴다. 글자 강조는 노랑의
어두운 짝(`--accent`)이 맡는다. 제목은 아주 굵은 고딕, 라벨은 고정폭 대문자 줄, 번호는 크다.
카드는 회청 바탕 위의 낱장(`--surface` + 1 px 괘선)이다. 절 머리는 3 px 굵은 괘선이 연다.
글은 짧게 쓰고 그림이 설명을 맡는다. 차례는 정적 `nav`, 테마는 CSS 가 맡는다.

## 토큰

색은 모두 CSS 변수다. 라이트 값은 `:root` 에, 다크 값은 두 자리에 같은 이름으로 둔다:
`@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } }` 와
`:root[data-theme="dark"] { … }`. 앞의 것은 OS 설정을, 뒤의 것은 뷰어 토글을 따른다.
`check.mjs` 의 `theme-dark-tokens` 가 두 자리의 이름을 맞춰 본다. 시안 페이지에는 다크가 없다.
다크 값은 v4 에서 새로 지었다. 같은 회청 계열의 어두운 바탕에 노랑이 그대로 하나뿐인 강조색이다.

| 토큰 | 라이트 | 다크 | 쓰는 곳 | 시안 페이지의 이름 |
| --- | --- | --- | --- | --- |
| `--bg` | `#e8ecee` | `#121619` | 페이지 바닥 | `--paper` |
| `--surface` | `#f8fafa` | `#1a1f23` | 낱장: 카드 · 그림 패널 · 표 · 축 띠 · 인용 · svg-diagram 상자 면 | `--sheet` |
| `--sunken` | `#eef1f3` | `#20262b` | svg-diagram 입출력 상자 면 | 새로 지음 |
| `--warm` | `#f7eece` | `#2a2618` | 체크 목록 상자 · 시안의 "새로 생기는 것" | `--litho-soft` 를 낱장 위에 깐 값 |
| `--ink` | `#111a22` | `#e9edf0` | 제목 · 굵은 글 | `--ink` |
| `--ink-2` | `#27313a` | `#c9d1d7` | 본문 | 새로 지음(`--ink` 를 한 단 누름) |
| `--ink-3` | `#525e69` | `#9aa6b0` | 라벨 · 메타 · 그림 설명 | `--muted`(#55616c 를 대비 때문에 한 단 누름) |
| `--line` | `#c9d1d6` | `#313a41` | 괘선 · 낱장 테두리 | `--rule` |
| `--line-soft` | `#dde3e6` | `#262d33` | 옅은 괘선 · svg-diagram 모눈 | 새로 지음 |
| `--accent` | `#6b4e00` | `#f5d672` | 글자 강조: 라벨 칩 글자 · 숫자 · svg-diagram 강조 선 · 글자 | `--litho-ink` |
| `--accent-bg` | `#f6e7a8` | `#3a3114` | 옅은 노랑 칩 · 차례 번호 · `.pill` · 고른 카드 | `--litho-soft` |
| `--on-accent` | `#ffffff` | `#1d1600` | `--accent` 면 위 글자 | 새로 지음 |
| `--litho` | `#f2c230` | 같음 | 노란 면: 형광펜 띠 · 그림 번호 · 번호 흐름 원 · 결정 번호 막대 · 체크 · 초점 테 | `--litho` |
| `--on-litho` | `#1d1600` | 같음 | 노란 면 위 글자 | 시안의 단추 글자 |
| `--blue` | `#2a6584` | `#7fb5d1` | 링크 · svg-diagram 분기 상자 · 되돌아가는 선 | `--info`(#2f6f8f 를 한 단 누름) |
| `--blue-bg` | `#dbe7ed` | `#1b2b33` | 인라인 코드 면 · 보조 면 | `--info-soft` |
| `--coral` | `#9a4b1b` | `#e3965f` | 둘째 보조 의미(시안의 `data` 갈래, 새 기능 줄) | `--data` |
| `--on-coral` | `#ffffff` | `#1a0f0c` | 산호 면 위 글자 | 새로 지음 |
| `--code-bg` · `--code-ink` | `#111a22` · `#dfe5e9` | `#0b0f12` · 같음 | 코드 블록 | `--ink` 면 |
| `--code-k` · `--code-s` · `--code-c` | `#f2c230` · `#9fd0e6` · `#8593a0` | 같음 · 같음 · `#7c8994` | 코드의 키 · 글 · 주석 | 노랑 · info 의 밝은 짝 |
| `--y-top` | `62%` | `82%` | 형광펜 띠의 윗변. 다크는 밝은 글자가 띠에 묻히지 않게 밑줄 높이로 내린다 | 새로 지음 |

글자 대비(WCAG, 라이트 / 다크): 본문 `--ink-2` 바닥 위 11.1 / 11.8, 라벨 `--ink-3` 바닥 위 5.6 / 7.3 ·
낱장 위 6.3 / 6.7, `--accent` 바닥 위 6.5 / 12.8 · `--accent-bg` 위 6.2 / 9.1, 링크 `--blue` 바닥 위
5.4 / 8.2, `--on-litho` 노랑 위 10.7, 코드 주석 5.6 / 5.4. 모두 4.5:1 이상이다.

svg-diagram 의 `doc` 스타일은 `--bg · --surface · --sunken · --ink · --ink-2 · --ink-3 · --line ·
--line-soft · --accent · --accent-bg · --blue · --blue-bg · --sans · --mono` 를 읽는다. 이 이름은
그대로 둔다.

글꼴은 셋이다. 모두 시스템 글꼴이다. 시안 페이지는 웹폰트(Black Han Sans · Noto Sans KR ·
JetBrains Mono)를 썼다. v4 는 그 느낌을 시스템 고딕의 가장 굵은 굵기(900) · 좁은 자간 · 큰 크기로 낸다.

| 토큰 | 쌓기 | 쓰는 곳 |
| --- | --- | --- |
| `--display` | Noto Sans CJK KR, Apple SD Gothic Neo, Malgun Gothic, `system-ui` — 굵기 900 | 제목 · 절 제목 · 큰 인용 · 큰 번호 |
| `--sans` | `system-ui`, Apple SD Gothic Neo, Noto Sans CJK KR, Malgun Gothic | 본문 · 그림 |
| `--mono` | `ui-monospace`, D2Coding, Noto Sans Mono CJK KR, Menlo, Consolas | 라벨 줄 · 번호 배지 · 코드 · 식별자 |

## 글자 크기

제목은 본문의 4 배 이상이다. `check.mjs` 의 `type-ratio` 가 미디어 밖 `h1` · `body` 규칙의
px · rem 값을 나눠 본다. `clamp()` 처럼 읽지 못하는 값은 경고로 알린다.

| 자리 | 넓은 화면 | 760 px 이하 | 굵기 · 글꼴 |
| --- | --- | --- | --- |
| 라벨 줄(좌표 줄 · 메타 · 표 머리 · 차례 머리) | 11 px, 자간 .14em, 대문자 | 같음 | 600 · `--mono` |
| 그림 설명 | 13 px | 같음 | 400 |
| 차례 | 14 px | 같음 | 400 |
| 본문 | 16 px | 15 px | 400 |
| 부제 · 첫 문단(`.lead`) | 18 px | 같음 | 400 · 500 |
| 축 띠 | 20 px | 17 px | 700 |
| 큰 인용 | 28 px | 22 px | 900 · `--display` |
| 절 제목 H2 | 40 px | 30 px | 900 · `--display` |
| 결정 번호 · 안 번호 | 44 · 96 px | 36 · 64 px | 900 · `--display` |
| 제목 H1 | 72 px | 46 px | 900 · `--display`, 자간 -.03em |

## 기둥

| 이름 | 값 | 뜻 |
| --- | --- | --- |
| `--measure` | 680 px | 글 폭. 절의 자식은 모두 이 폭으로 가운데에 선다 |
| `--wide` | 920 px | 넓은 폭. `.wide` 를 붙인 그림 · 코드 · 패턴 |
| 차례 | 200 px | 1100 px 이상에서 왼쪽에 붙어 따라온다(`position: sticky`) |
| 바깥 여백 | 16 px | 폰 폭에서도 같다 |
| 절 사이 | 88 px | `h2` 위 여백. 폰은 64 px |

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
- 노랑은 한 화면에 몇 군데만 둔다. 형광펜 띠(`.y`)는 제목의 한 구절에만 긋는다.

## 부품

### 머리 — 좌표 줄 → 제목 → 부제 → 메타

넷만 둔다. 순서는 `check.mjs` 의 `head` · `head-order` 가 본다. 좌표 줄의 `path` 는
대분류 › 중분류 › 이 문서, `rel` 은 관련 문서다. 링크가 있으면 `a`, 없으면 `span` 으로 쓴다.
좌표 줄은 고정폭 대문자 라벨 줄이다. 이 문서(`aria-current`)는 노란 배지로 선다. 제목의 한 구절은
`span.y` 로 노란 형광펜 띠를 긋는다(골라 쓴다).

```html
<header class="wrap head">
  <nav class="coord" aria-label="문서 좌표">
    <span class="path"><span>fdc-agent</span> › <span>AKG</span> › <span aria-current="page">설계 문서</span></span>
    <span class="rule" aria-hidden="true"></span>
    <span class="rel"><small>관련</small><a href="#next">JSON 스펙 v0.10.0</a></span>
  </nav>
  <h1 id="top">에이전트가 읽는 지식, 한&nbsp;곳에서 <span class="y">맞다고 정한다</span></h1>
  <p class="sub">agent-knowledge-governance 설계 · v0.4.7&nbsp;초안</p>
  <p class="meta"><span>2026-07-17</span><span>읽는 데 6 분</span></p>
</header>
```

### 축 띠 — `p.axis` (머리 밑, 골라 쓴다 · 시안 모드는 늘)

"이 문서가 무엇에 대한 것인가" 를 한 줄로 둔다. 낱장 위 굵은 글 + 옅은 노랑 라벨 칩이다.
메타 밑, `header` 안에 둔다. 출처 한 줄은 `small` 로 붙인다.

```html
<p class="axis" data-axis-from="user"><span class="k">축</span>새 메모의 템플릿을 어디서 고르나.
  <small>축은 사용자 말 "…"(11-10 01:10)에서.</small></p>
```

### 차례 — 고정 `nav.toc` + 접이 `details.toc-m`

같은 목록을 두 번 쓴다. 링크와 `section id` 는 손으로 맞춘다(`anchor` 가 본다).
번호는 옅은 노랑 칩이고, `:target` 절은 낱장 면 + 왼쪽 노란 막대로 선다.
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

절 제목 위에 3 px 굵은 괘선(`--ink`)이 선다. 시안 페이지의 안 머리와 같은 꼴이다.

```html
<section id="s1">
  <h2>지금 무엇이 곤란한가</h2>
  <p class="lead">에이전트는 프롬프트에 맞는 지식 문서를 받아서 답한다.</p>
</section>
```

### 그림 카드 — `figure > .panel` + 번호 배지 설명

패널은 낱장이다. 안에는 svg-diagram 조각을 넣는다. 번호 배지는 노란 면에 고정폭 숫자다.
넓은 그림은 `figure.wide` 로 둔다.

```html
<figure class="wide">
  <div class="panel"><svg class="d s-doc" …>…</svg></div>
  <figcaption><span class="no">2</span><span>아키텍처</span></figcaption>
</figure>
```

### 표 — `.table-scroll` 안에 (`table-scroll` 이 본다)

표는 낱장이다. 머리는 고정폭 대문자 라벨 줄, 수치 칩 `.pill` 은 옅은 노랑 칩이다.

```html
<div class="table-scroll">
  <table>
    <thead><tr><th>인스턴스</th><th>우선순위</th></tr></thead>
    <tbody><tr><td class="id">msg-format</td><td><span class="pill">65</span></td></tr></tbody>
  </table>
</div>
```

### 큰 인용 상자 — `.pull`

한 문장으로 줄인 접근을 크게 보인다. 낱장 왼쪽에 8 px 노란 막대가 서고, 글은 굵은 표시 글꼴이다.
식 한 줄은 아래 `pull-code` 에 둔다.

```html
<div class="pull">
  <blockquote><p>문서의 원본은 JSON&nbsp;이다.</p></blockquote>
  <p class="pull-code"><code>render(json) === md</code></p>
</div>
```

### 번호 흐름 — `ol.flows`

번호는 노란 원 숫자다. 시안 페이지의 손동작 표지와 같은 꼴이다.

```html
<ol class="flows">
  <li><b>읽기.</b> 키워드는 늘 로컬 미러에서 찾는다.</li>
</ol>
```

### 결정 카드 — `ol.dec`

카드 하나 = 제목 한 줄 + 까닭 한 줄. 번호는 44 px 표시 글꼴이고 밑에 노란 막대가 선다
(시안 페이지의 안 번호와 같은 꼴).

```html
<ol class="dec">
  <li><b>저장소는 git 레포가 전부다.</b> 변경 하나 = 커밋 하나.</li>
</ol>
```

### 체크 목록 — `.note > ul.checks`

`li.done` 은 정한 것이다. 칸이 노랗게 채워지고 `정함` 꼬리표가 붙는다. 빈 칸은 남은 것이다.

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

좌표 줄의 관련 문서와 같은 목록이다. 위에 3 px 굵은 괘선이 선다.

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

## 시안 부품 (mockup 패턴)

시안 모드만 쓰는 부품이다. 축 띠 · 낱장 · 표 · 라벨 줄은 템플릿 것을 쓴다. 시안에만 있는 화면 틀 ·
안 카드 · 장면 줄의 CSS 는 [patterns/mockup.html](patterns/mockup.html) 의 `mockup 패턴 CSS` 블록에
있다. 이 블록은 `--wide` 를 1240 px 로 늘린다. 안 절(`section.opt`)의 자식은 모두 넓은 폭을 쓴다.
차례의 `:target` 강조는 `o1` ~ `o12` 까지 있다.

### 축 줄 — `p.axis` (`mockup-axis` 가 본다)

템플릿의 축 띠다. 시안은 `data-axis-from` 을 늘 붙인다: `user`(사용자 말에서) · `author`(내가 고른 축).

### 안 카드 — `section.opt#oN` (`mockup-opts` · `mockup-ref` 가 본다)

큰 번호는 96 px(본문의 6 배)다. 밑에 노란 막대가 선다. 레퍼런스 줄은 제품 링크를 담는다. 직접 지은 안은 `p.ref.own` 이다.
`p.need` 는 새 기능이 있어야 그려지는 안에만 둔다.

```html
<section class="opt" id="o3">
  <div class="opt-head">
    <span class="opt-no">3</span>
    <h2>오른쪽 템플릿 패널</h2>
    <p class="one">편집기 오른쪽에 템플릿 패널을 연다.</p>
    <p class="ref"><span class="k">레퍼런스</span><a href="https://…">제품 · 화면</a> — 한 줄</p>
    <p class="need"><span class="k">새 기능</span>템플릿 미리보기 기능이 있어야 한다(없음)</p>
  </div>
  <p class="states"><span>S1 고르기 직전</span><i>→</i><span>S2 고른 뒤</span></p>
  <div class="shots">…장면…</div>
</section>
```

### 화면 틀 — `.scr > .v` (`mockup-frame` · `mockup-zoom` · `mockup-app-tokens` 가 본다)

`.v` 는 1440 × 900 px 다. `.scr` 가 `container-type: inline-size` 이고, `.v` 를
`scale(tan(atan2(100cqw, 1440px)))` 로 줄인다. `a.zopen` 이 틀을 `:target` 으로 만들어 100% 로 덮는다.
`a.zclose` 는 figure 로 돌아간다. 틀 안 색은 앱 토큰(`--a-…`, 라이트 고정)만 쓴다.

```html
<figure class="shot" id="o3-s1">
  <div class="scr" id="o3-s1-z">
    <div class="v"><div class="app">…1440 × 900 앱 화면…</div></div>
    <a class="zopen" href="#o3-s1-z" aria-label="안 3 S1 100% 로 보기"></a>
    <a class="zclose" href="#o3-s1">닫기 · 100% 1440 × 900</a>
  </div>
  <figcaption><b>S1</b>새 메모를 시작해 템플릿을 고르기 직전</figcaption>
</figure>
```

### 장면 줄 — `p.states` + `.shots` (`mockup-scenes` 가 본다)

상태 축 한 줄 밑에 장면 그림을 둔다. 넓은 화면은 두 열, 760 px 이하는 한 열이다. 그림 하나만 두는 자리
(지금 화면)는 `.shots.one` 이다. 모든 안의 장면 수는 같다.

### 비교표 · 레퍼런스 — `table.cmp` · `ol.refs` (`mockup-compare` 가 본다)

비교표는 `.table-scroll` 안에 둔다. 맨 위 줄(`tr.now`)이 지금 화면이다. `td.no` 는 안 번호, `td.n` 은 수다.

## 패턴

여러 부품을 묶은 뼈대는 `patterns/` 에 견본 문서로 둔다. 견본 파일이 복사 원본이다.
CSS 와 마크업에 `START … END` 표시가 있다.

| 패턴 | 언제 | 파일 |
| --- | --- | --- |
| versus | 정확히 두 대상을 맞세운다. 두 카드가 같은 dl 라벨을 같은 순서로 쓴다 | [patterns/versus.html](patterns/versus.html) |
| triptych | 대안 세 안(`pick` 하나) 또는 대표 수치 셋(`h3.num`) | [patterns/triptych.html](patterns/triptych.html) |
| mockup | 시안 모드의 페이지 전부. 축 줄 · 안 카드 · 화면 틀 · 장면 줄 · 비교표 · 레퍼런스 | [patterns/mockup.html](patterns/mockup.html) |

mockup 견본에는 CSS 블록이 둘 있다. `mockup 패턴 CSS` 는 그대로 붙인다. `앱 화면 CSS` 는 견본 앱(Memo)이라
대상 앱의 토큰 · class 로 바꾼다. 마크업은 `CONTENT:START` 부터 `END` 까지가 복사 원본이다.

흐름 · 순서 · 구조 그림은 svg-diagram 이 그린다. [SKILL.md](SKILL.md) 의 그림 결정표를 본다.
