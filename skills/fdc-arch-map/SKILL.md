---
name: fdc-arch-map
argument-hint: "[바뀐 것 | PR 번호 … | 플로우를 더할 API 경로]"
description: >-
  fdc-agent-be 의 호출 지도(BE 레포 docs/architecture-map/be-architecture-map.html)를 고치고 다시 그릴 때 쓴다.
  지도는 사람 → API → Service → 바깥 시스템을 놓고 호출 하나를 화살표 하나로 그린 클릭형 HTML 한 장이다.
  BE 에 API 경로 · Service · 호출 · 그래프 노드가 바뀌었을 때, API 상자에 호출 순서 번호(플로우)를 더할 때,
  상자 자리나 줄이 빽빽해 고칠 때, 지도를 Artifact 에 다시 올릴 때 읽는다.
  코드에서 사실 읽는 법, 무엇을 어느 파일에서 고치나(gen.js 의 apis · calls · 자리, html 의 D · A · GN · FLOWS),
  생성기 gen.js · 검사 check.js · 내보내기 to-artifact.js 쓰는 법, 줄 긋는 규칙(호출마다 제 줄 · 한 점에 꺾임 하나 ·
  다리 · 표시 A · L), 헤드리스 크롬으로 화면 보기, PR 과 Artifact 올리기를 담는다.
---

# fdc-arch-map

fdc-agent-be 의 호출 지도를 고치고 다시 그리는 스킬이다.

- **지도**: `docs/architecture-map/be-architecture-map.html` 한 장이다. 왼쪽부터 사람 → API → BE 의 Service → 바깥 시스템을 놓는다.
- **상자**: 지도의 네모 하나다. API 상자는 경로 앞머리 하나, BE 안 상자는 Service 하나(패키지 하나)다.
- **줄**: 화살표 하나다. 코드에서 확인한 호출 하나를 뜻한다.
- **표시**: 줄 대신 부르는 상자에 붙이는 동그라미다. `A` 는 AuthService, `L` 은 LlmService 를 부른다는 뜻이다.
- **플로우**: API 상자 하나를 눌렀을 때 줄에 붙는 호출 순서 번호다.

근거 파일(BE 레포 [ollybaysion/fdc-agent-be-spring](https://github.com/ollybaysion/fdc-agent-be-spring), `docs/architecture-map/`):

| 파일 | 쥔 것 |
| --- | --- |
| `be-architecture-map.html` | 결과물. 상자 설명 `D` · 안쪽 구조 `A` · Runner 그래프 `GN` · 플로우 `FLOWS` · 그리는 코드 |
| `gen.js` | 생성기. API 상자 `apis` · Service 사이 호출 `calls` · 상자 자리 · 줄 긋는 규칙. html 의 `NODES` · `EDGES` · API 상자 설명을 다시 쓴다 |
| `check.js` | 검사. 데이터 맞춤 · 꺾인 점 겹침 0 · 줄 겹침 0 |
| `to-artifact.js` | Artifact 에 올릴 꼴로 내보낸다 |

다른 스킬과 나누기:

| 할 일 | 스킬 |
| --- | --- |
| BE 호출 지도를 고치고 다시 그린다 | 이 스킬 |
| 설명용 그림 하나를 스펙에서 SVG 로 만든다 | [`svg-diagram`](../svg-diagram/SKILL.md) |
| 설계 문서 · 보고서를 HTML 한 장으로 만든다 | [`html-doc`](../html-doc/SKILL.md) |

## 1. 언제 쓰나

| 일어난 일 | 고칠 곳 |
| --- | --- |
| API 경로가 생겼다 · 옮겨졌다 | `gen.js` 의 `apis` (2.2절) |
| 컨트롤러가 부르는 Service 가 바뀌었다 | `gen.js` 의 `apis` 의 부르는 Service 칸 |
| Service 가 다른 Service · 바깥 시스템을 새로 부른다 | `gen.js` 의 `calls` (2.3절) |
| Service(패키지)가 생겼다 · 합쳐졌다 | `gen.js` 의 상자 자리 + `calls` + html 의 `D` · `A` (2.4절) |
| Runner 그래프의 노드가 바뀌었다 | html 의 `GN` 과 `graphHtml` (2.5절) |
| API 하나의 호출 순서를 보여 주고 싶다 | html 의 `FLOWS` (4절) |
| 줄이 빽빽하다 · 긋지 못한 호출이 나온다 | `gen.js` 의 상자 자리 상수 (5절) |

## 2. 고치는 절차

1. BE 레포를 `git fetch` 한다. `origin/main` 에서 워크트리와 브랜치를 판다.
2. 지도 머리줄의 기준 커밋을 읽는다. `git log <기준>..origin/main --oneline` 으로 그 뒤의 변경을 본다.
3. 변경마다 코드에서 사실을 읽는다(2.1절).
4. 데이터를 고친다(2.2 ~ 2.5절).
5. `node docs/architecture-map/gen.js` 를 돌린다. 1 ~ 2 분 걸린다.
6. 마지막 줄을 읽는다(3절).
7. `node docs/architecture-map/check.js` 를 돌린다. `깨끗함` 이 나와야 한다.
8. 화면을 본다(6절).
9. 지도 머리줄의 기준 커밋 · 날짜 · 계약 버전을 고친다. `docs/README.md` 표와 `docs/architecture-map/README.md` 의 기준도 같이 고친다.
10. PR 을 올린다. 사용자가 원하면 Artifact 에도 올린다(7절).

### 2.1 코드에서 사실 읽기

줄 하나는 코드에서 확인한 호출 하나다. 추측으로 줄을 긋지 않는다.

- **API 상자가 부르는 Service**: 컨트롤러(`src/main/java/fdc/agent/api/<묶음>/`)의 생성자가 주입받는 `*Service` 필드를 읽는다.
- **Service 사이 호출**: 부르는 패키지에서 `private final <다른 패키지의 Service>` 필드와 그 필드의 메서드 호출을 찾는다. 툴 · 포트 구현이 대신 부르는 호출도 그 패키지의 호출이다.
- **바깥 시스템**: 포트 구현(`port/impl/`)이 무엇에 붙는지 읽는다(HTTP · Redis · Neo4j · JDBC).
- **계약 경로**: `contract/openapi.json` 이 원본이다. `gen.js` 가 경로를 가장 긴 앞머리의 API 상자에 붙인다.

설명 글에 적는 사실마다 근거를 `파일:줄` 로 남긴다(html `D` 의 `ref`, `FLOWS` 의 `ref`).

### 2.2 API 상자 — `gen.js` 의 `apis`

묶음(틀) 안에 상자를 한 줄씩 적는다.

```js
['a-ag-answer', '/answer', '/agent/answer', 'agent/AgentAnswerController', ['chat', 'p-auth'], '한 줄 설명', ['하는 일 …']]
//  상자 id       (안 씀)    계약 앞머리        컨트롤러                       부르는 Service      one           does
```

- 상자 라벨은 실제 경로 전체다(`/api/fdc/v1/agent/answer`). `gen.js` 가 앞머리에서 만든다.
- 상자 id 는 `g-` · `a-` · `f-` 로 시작한다. 이 머리가 API 상자라는 표시다.
- API 상자의 설명(`D`)과 안쪽 구조(`A`)는 `gen.js` 가 html 의 `/*API-D*/` · `/*API-A*/` 구간에 쓴다. html 에서 손으로 고치면 다음 실행에 덮인다.

### 2.3 Service 사이 호출 — `gen.js` 의 `calls`

```js
const calls = {
  'chat': ['runner', 'knowledge', 'data', 'p-admin', 'p-auth'],
  …
};
```

키가 부르는 상자, 값이 불리는 상자들이다. `p-auth` · `llm` 으로 가는 호출은 생성기가 표시 `A` · `L` 로 바꾼다(`BADGE`).

### 2.4 상자 자리와 설명

- 자리는 `gen.js` 의 `sv(...)` · `put(...)` 줄에 손으로 적는다. 값은 8 의 배수다.
- 열 사이 간격은 상수 `L` · `R1` · `K1` 의 `+ 176` 이다. 줄이 16px 마다 한 줄 지나가니 176px 에 열 줄쯤 지나간다.
- BE 안 상자의 설명은 html 의 `D['<id>']` 에 쓴다: `kind` · `title` · `one` · `does` · `ref`.
- 안쪽 구조(Method → Tool → Port)는 html 의 `A['<id>']` 에 쓴다.
- 상자 라벨은 한 줄이다. Service 상자의 라벨은 패키지 이름이다(`Chat`, `Knowledge`).

### 2.5 Runner 그래프

Runner 상자를 누르면 열리는 그래프는 html 의 `GN`(노드 목록)과 `graphHtml()`(가로 한 줄 배치와 되돌아가는 호)이 그린다. 노드를 더하면 `GN` 에 항목을 넣고 `graphHtml` 의 `endX` · 호(`arc(...)`)를 같이 고친다.

## 3. `gen.js` 의 출력 읽기

```text
ext order x-redis x-kg x-voc x-akg score 3189 -> 2888
size 2656 x 1312 nodes 38 edges 62 calls 58 bends 68 cross 94 badges 16 fail [] unassigned [ … ]
```

| 칸 | 뜻 | 할 일 |
| --- | --- | --- |
| `fail` | 긋지 못한 호출 | 비어 있어야 한다. 이름이 나오면 상자 사이를 넓힌다(5절). 나오면 종료 코드가 1 이다 |
| `unassigned` | 계약에 있는데 어느 API 상자에도 붙지 않은 경로 | `apis` 에 상자를 더하거나 앞머리를 고친다 |
| `calls` | 호출 수(줄 + 표시) | 지도 안내 문장의 "호출 N 개" 로 들어간다 |
| `cross` · `bends` | 교차 · 꺾임 수 | 자리를 바꿨을 때 전과 견준다 |
| `ext order` | 오른쪽 바깥 상자의 위아래 순서 | 생성기가 스물네 가지를 돌려 고른다 |

`--dry` 는 그려 보고 숫자만 찍는다. 씨앗이 고정이라 같은 입력은 늘 같은 지도가 된다.

## 4. 플로우 더하기 — html 의 `FLOWS`

API 상자 하나에 호출 순서를 단다. 키는 API 상자 id 다.

```js
'g-chat': { name: 'POST /api/fdc/v1/chat', cap: '목록 위 안내 한 줄', more: '목록 아래 덧붙임(선택)',
  steps: [
    { t: 'API → Chat', d: '입력을 검사합니다.', ref: 'ChatController.java:125 → ChatService.check', e: [['g-chat', 'chat']] },
    …
  ] }
```

1. 컨트롤러 메서드에서 시작해 호출을 순서대로 따라간다. 단계마다 근거 `파일:줄` 을 적는다.
2. 단계 하나가 번호 하나다. `e` 에 그 단계의 줄 `[부르는 상자, 불리는 상자]` 를 적는다. 지도에 있는 줄만 적는다(`check.js` 가 본다).
3. 한 단계에서 같이 일어나는 호출은 `e` 에 같이 넣는다. 같은 번호가 붙는다.
4. 그래프 안처럼 질문마다 순서가 달라지는 구간은 한 단계로 묶는다. 설명에 "질문에 따라 고르고 되풀이합니다" 를 적는다.
5. 그 플로우에서 닿는 것을 코드로 확인한 줄만 넣는다. 확인하지 못한 줄은 넣지 않고 보고에 "미확인" 으로 적는다.
6. 줄이 없는 단계(응답 보내기)는 `e: []` 로 둔다. 목록에만 나온다.

번호 자리는 지도가 줄에서 계산한다(가장 긴 토막의 가운데, 한 줄에 번호가 둘이면 화살표 방향 순서). 표시로 그린 호출은 표시 바로 아래에 붙는다.

## 5. 줄 긋는 규칙과 걸리는 곳

지도의 규칙이다. 생성기가 지키고 `check.js` 가 본다.

1. 화살표 하나가 호출 하나다.
2. 호출마다 제 줄을 처음부터 끝까지 긋는다. 같은 Service 로 가는 줄도 합치지 않는다. 줄끼리는 16px 떨어진다.
3. 한 점에는 꺾임 하나만 둔다. 같은 가로줄 · 세로줄의 꺾인 점끼리는 32px 넘게 띄운다(`NEAR = 4` 칸). 꺾인 점이 만나면 두 줄이 한 줄로 이어져 보인다.
4. 가로 줄이 다른 줄을 넘는 자리는 다리 모양이다.
5. 여러 상자가 부르는 Service(Auth · Llm)는 줄 대신 표시로 그린다. 표시의 뜻은 지도 안 범례와 아래 설명 칸의 범례에 적는다.
6. API 상자의 줄은 상자 오른쪽에서 나간다.
7. 상자 곁(16px)과 다른 줄 위에서는 꺾지 않는다. 틀 이름(`BE`) 자리는 줄이 비켜 간다.
8. 테두리는 실선이다.

걸리는 곳:

- **`fail` 에 이름이 나온다**: 그 호출이 지나갈 칸이 모자란다. 열 사이 간격(`+ 176`)이나 아래 줄의 높이(`ROW`)를 16 의 배수로 넓힌다.
- **교차가 크게 늘었다**: 상자의 위아래 순서를 바꿔 본다. 부르는 상자와 불리는 상자가 같은 높이에 오면 줄이 곧다.
- **줄이 틀 밖으로 돈다**: 틀 안에 지나갈 길이 막힌 것이다. 막은 상자 둘 사이를 넓힌다.
- **`check.js` 가 꺾인 점 겹침 · 줄 겹침을 찍는다**: `gen.js` 가 그은 줄에서는 0 이 나온다. 손으로 적은 줄(사람 → UI 넷)을 고쳤을 때 본다.

## 6. 화면 보기

브라우저로 `be-architecture-map.html` 을 연다. 헤드리스 크롬으로 찍을 때는 이렇게 한다.

```bash
google-chrome --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
  --window-size=2700,1400 --screenshot=/tmp/map.png \
  "file://$PWD/docs/architecture-map/be-architecture-map.html"
```

상자를 누른 상태는 html 을 복사해 끝에 클릭 한 줄을 붙여 찍는다.

```html
<script>
  window.scrollBy = function () {};
  document.querySelector('.n[data-id=g-chat]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
</script>
```

보는 것:

1. 평소 상태: 줄이 상자 글자와 틀 이름을 지나가지 않는다.
2. 고친 상자를 누른 상태: 나가는 줄 · 들어오는 줄이 색으로 남고 아래 설명 칸이 열린다.
3. 플로우가 있는 API 상자를 누른 상태: 번호가 서로 겹치지 않는다. 목록의 한 줄을 누르면 그 단계의 줄만 남는다.
4. 어두운 테마: `<html data-theme="dark">` 로 한 번 본다.

## 7. 올리기

**PR**: BE 레포에 `docs/architecture-map/` 의 변경과 `docs/README.md` 의 기준을 한 커밋으로 올린다. PR 글에 `gen.js` 의 마지막 줄과 `check.js` 의 결과를 적는다.

**Artifact**: 사용자가 원할 때 올린다.

1. `node docs/architecture-map/to-artifact.js <나갈 파일.html>` 을 돌린다. 문서 머리를 걷고 IBM Plex 글꼴 줄을 넣은 판이 나온다.
2. 그 파일을 Artifact 도구로 올린다. 있던 지도를 고칠 때는 그 주소를 `url` 로 준다.

레포의 지도는 웹 글꼴을 부르지 않는다(BE `docs/` 의 문서는 바깥 요청 0 이다). 글꼴 줄은 Artifact 판에만 있다.

## 8. 글 규칙

- 지도의 글은 "~합니다" 로 쓴다. 한 문장에 서술어 하나를 둔다.
- 하는 것만 적는다: "추천 질문은 `recommend_question` 이 만듭니다".
- 순서가 있는 호출 길은 "플로우" 라고 부른다.
- API 경로를 받는 자리는 "API" 라고 부른다.
- 결함은 "버그" 라고 부른다.
