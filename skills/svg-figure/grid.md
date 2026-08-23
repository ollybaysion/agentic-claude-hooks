# grid.md — 좌표 상수 · 글자 수 상한 · 팔레트

**이 파일의 목적은 계산을 없애는 것이다.** 좌표는 여기 있는 상수를 더해서 만들고,
텍스트는 상한표를 보고 자른다. 나눗셈이나 폭 측정이 나오면 잘못 가고 있는 것이다.

## 캔버스

```xml
<svg xmlns="http://www.w3.org/2000/svg"
     id="<접두사>" viewBox="0 0 <W> <H>"
     width="100%" preserveAspectRatio="xMidYMid meet"
     font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', Roboto, sans-serif">
  <rect x="0" y="0" width="<W>" height="<H>" fill="#F9FAFA"/>
  …
</svg>
```

- `height` 속성은 **쓰지 않는다** — viewBox 종횡비로 계산돼 Confluence 칼럼 폭에 맞는다.
- 배경 rect는 **필수**다 (다크 모드에서 도형이 사라지는 것 방지).
- 캔버스 최대 폭 **960**, 사방 여백 **24**.
- 좌표는 **4의 배수**(8 권장). 소수 좌표 금지.

## 팔레트 (라이트 고정)

html-doc editorial v2와 같은 값이다. 이 목록 밖의 색은 쓰지 않는다.

| 이름 | 값 | 용도 |
| --- | --- | --- |
| ink | `#14181B` | 본문 텍스트, 실선 |
| ink-2 | `#47535B` | 보조 텍스트 |
| ink-3 | `#6E7C85` | 라벨, 흐린 텍스트, 점선 |
| line | `#D2D8DB` | 박스 테두리 |
| line-soft | `#E2E6E8` | 그룹 테두리 |
| surface | `#F9FAFA` | 캔버스 배경 |
| box | `#FFFFFF` | 박스 채움 |
| sunken | `#E5E9EA` | 강조 없는 채움 |
| accent | `#A8451A` | 강조 — 도형당 하나의 의미에만 |
| blue | `#3F6180` | 보조 의미가 필요할 때만 |

옅은 채움이 필요하면 `rgba()`가 아니라 `fill="#A8451A" fill-opacity="0.09"`.

## 타이포

| 쓰임 | size | weight |
| --- | --- | --- |
| 도형 제목 | 16 | 600 |
| 박스 라벨 | 13 | 500 |
| 보조 라벨·주석 | 11 | 400 |
| 식별자·코드 | 12 (mono) | 400 |

mono 스택: `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`

박스 안 텍스트는 `text-anchor="middle"` + `dominant-baseline="central"`, x·y는 박스 중심.

## 글자 수 상한표 (폭 계산 금지)

박스 폭별로 **한 줄에 들어가는 최대 글자 수**다. 넘으면 `tspan` 두 줄로 나눈다
(두 줄이면 y를 각각 중심 −8 / 중심 +8).

| 박스 폭 | 13px 한글 | 13px 영문 | 11px 한글 | 11px 영문 |
| --- | --- | --- | --- | --- |
| 120 | 7 | 13 | 8 | 15 |
| 152 | 9 | 17 | 11 | 21 |
| 176 | 11 | 21 | 13 | 25 |
| 200 | 13 | 24 | 16 | 29 |
| 240 | 16 | 30 | 19 | 35 |

**한글·영문이 섞이면**: 영문·숫자 2글자를 한글 1글자로 세고 한글 열을 본다.

## sequence — 참여자 왕복

참여자 수에 따라 폭이 정해진다. 표에서 골라 쓴다.

| 참여자 N | 박스 폭 | pitch | 캔버스 W |
| --- | --- | --- | --- |
| 2 | 176 | 208 | 432 |
| 3 | 176 | 208 | 640 |
| 4 | 176 | 208 | 848 |
| 5 | 152 | 176 | 904 |
| 6 | 120 | 144 | 888 |

- 참여자 i(0부터)의 박스 x = `24 + i × pitch`, y = `24`, 높이 `40`
- 생명선 x = `박스 x + 박스 폭 ÷ 2` → 표의 박스 폭 절반: 176→88, 152→76, 120→60
- 생명선 y = `64` → `H − 24`
- 메시지 i(0부터)의 y = `112 + i × 56`
- 메시지 라벨 y = `화살표 y − 8`, size 11, `text-anchor="middle"`
- **캔버스 H = `176 + (M−1) × 56`** (M = 메시지 수)

## flow — 분기 있는 처리 흐름 (위→아래)

- 캔버스 W = `704`, 중앙선 x = `280`
- 단계 박스: w `240`, h `64`, x `160`
- 분기 마름모: w `240`, h `88`, 중심 x `280`
- 세로 pitch: 단계 → 다음 단계 `112`, 단계 → 분기 `112`, 분기 → 다음 `136`
- 첫 박스 y = `24`
- 오른쪽 가지 박스 x = `440` (w 240), 같은 행의 y를 쓴다
- 캔버스 H = `마지막 박스 y + 그 높이 + 24`

## arch — 계층·그룹과 컴포넌트

- 캔버스 W = `960`, 그룹 박스 x `24`, w `912`
- 그룹 안 컴포넌트: w `200`, h `64`, pitch `224`
- 컴포넌트 x = `40 + i × 224` → 40 · 264 · 488 · 712 (한 행 최대 **4개**)
- 컴포넌트 행 pitch = `88`
- 그룹 높이 = `48 + 행수 × 88` (제목 줄 포함)
- 그룹 간 세로 간격 = `32`
- 그룹 제목: 그룹 좌상단에서 x+16, y+24, size 11, `#6E7C85`, `text-anchor="start"`

## 화살표

marker 대신 **명시 polygon**을 쓰면 id 충돌 걱정이 없지만 좌표가 늘어난다.
템플릿은 marker를 쓰되 **id에 파일 접두사를 붙인다**:

```xml
<defs>
  <marker id="<접두사>-arrow" viewBox="0 0 8 8" refX="7" refY="4"
          markerWidth="8" markerHeight="8" orient="auto-start-reverse">
    <path d="M0,0 L8,4 L0,8 z" fill="#47535B"/>
  </marker>
</defs>
<line … stroke="#47535B" stroke-width="1.5" marker-end="url(#<접두사>-arrow)"/>
```

되돌아오는(응답) 화살표는 `stroke-dasharray="4 4"`로 구분한다.
