---
name: svg-diagram
argument-hint: "[스펙.json | 그릴 것 설명] [--style KEY]"
description: "설명용 그림을 스펙(JSON)→생성기→SVG 로 만든다. 스타일 열 벌. 그림·다이어그램·흐름도를 그려 달라면 발동."
---

# svg-diagram

설명용 그림을 **데이터와 생성기로 나눠** 만든다. 사람(또는 Claude)은 스펙에
구조만 적고 — 무엇이 어느 칸에 있고, 무엇과 이어지고, 어떤 순서인지 —
생성기가 좌표를 계산해 SVG 를 낸다. 손으로 쓴 절대 좌표 SVG(예: RunnerService
그래프 v3)는 글 한 줄만 바뀌어도 상자 · 선 · 라벨을 전부 다시 맞춰야 했다.
스펙 한 줄을 고치면 생성기가 나머지를 다시 맞춘다.

스타일 시안(열 벌 중 아홉, 그림 넷):
[Artifact HXybPraHXYEhd544FDYyCM](https://claude.ai/artifact/HXybPraHXYEhd544FDYyCM)

## 철칙

1. **좌표를 손으로 쓰지 않는다.** `<svg>` 안의 숫자는 전부 생성기가 낸다.
   그림을 고칠 때도 스펙을 고치고 다시 생성한다.
2. **스펙에는 구조만.** 칸 번호(col · row) · 순서 · 연결 · 글. 폭 · 높이 · 좌표
   · 색은 스펙에 없다.
3. **생성기가 없는 그림 종류는 생성기부터 만든다.** `lib/generators.mjs` 의
   머리 규칙대로 생성기를 하나 더 쓰고 `specs/` 에 예시 스펙을 둔 뒤 그린다.
   한 번 쓰고 버릴 그림이라도 같다.
4. **SVG 안에는 좌표와 class 만.** 색 · 선 굵기 · 글꼴은 CSS 토큰(`.d …`)이
   정한다. 인라인 `style` · `fill="#…"` 을 넣지 않는다.
5. **script 0 · 외부 요청 0.** 웹폰트는 호스트 페이지의 일이다(Artifact 는
   Google Fonts 링크, 오프라인 문서는 시스템 글꼴 폴백).
6. **글자는 기준 16px 비율.** 제목 1.25 · 상자 글 1 · 키 0.9 · 선 라벨 0.95 ·
   꼬리표 0.85(손그림만 기준 18px). 상자 폭은 글자 폭을 재서 정하므로 글이
   상자를 넘치지 않는다 — 그래도 미리보기로 확인한다.

## 그림 종류 — 생성기 결정표

| 표현할 것 | kind | 스펙에 적는 것 | 예시 |
| --- | --- | --- | --- |
| 상자 안에 키 · 값 줄이 있는 흐름 그래프, 되돌아가는 선 | `boxflow` | nodes(col · row · title · rows) · edges | [specs/flow.json](specs/flow.json) |
| 무엇이 어느 칸에 있고 무엇과 이어지는지, 경계 프레임 | `gridmap` | boxes(col · row) · frames · edges | [specs/grid.json](specs/grid.json) |
| 요청 하나가 참여자 사이를 오가는 순서, loop 묶음 | `sequence` | parts · msgs · blocks | [specs/sequence.json](specs/sequence.json) |
| 누가(레인) 하는지와 순서 | `swimlane` | lanes · steps · flows | [specs/lane.json](specs/lane.json) |
| 그 밖 | 없음 | **생성기를 먼저 만든다**(철칙 3) | — |

## 절차

1. 결정표에서 kind 를 고른다. 없으면 생성기를 먼저 만든다.
2. `specs/` 의 예시를 복사해 스펙 JSON 을 쓴다. `kind` · `id`(페이지 안에서
   유일한 marker id 접두) · `caption`(figcaption 과 aria-label) 은 필수다.
3. 스타일을 고른다. `--style KEY` 또는 스펙의 `"style"`. default 는 미정이라
   지금은 꼭 적는다. 목록은 `node gen.mjs --list`.
4. 미리보기를 만들어 연다. 넘침 · 겹침 · 라벨 가림을 눈으로 본다. 어긋나면
   스펙(글 길이 · 칸 배치)이나 생성기를 고친다.

   ```bash
   node "<이 스킬 폴더>/gen.mjs" <스펙.json> --style KEY --html /tmp/preview.html
   ```

5. 붙인다. 셋 중 하나:
   - **토큰을 쓰는 HTML 문서 안**: 스타일 `doc`(문서의 `--ink · --line · --accent ·
     --sans …` 토큰을 따라 라이트 · 다크가 같이 바뀐다) 또는 원하는 스타일. 페이지
     `<style>` 끝에 `--css` 출력을 **한 번** 넣고, SVG 조각을 `<figure>` 안에 넣는다.

     ```bash
     node "<이 스킬 폴더>/gen.mjs" --css --style doc            # <style> 에 한 번
     node "<이 스킬 폴더>/gen.mjs" <스펙.json> --style doc      # <figure> 안에
     ```

   - **Artifact 페이지**: 같은 방법에 더해 스타일의 `webfonts` 링크(`--list` 의
     스타일, `lib/styles.mjs`)를 `<link rel="stylesheet">` 로 넣는다. 프리텐다드는
     Google Fonts 에 없어서 `@font-face` 로 심어야 한다.
   - **독립 .svg**(README · 이미지): `--svg 파일.svg`. 스타일 CSS 가 안에 들어간다.

6. 파일 경로를 보고한다. 스펙 파일은 산출물 옆에 둔다 — 스펙이 진실원이고
   SVG 는 파생물이다.

## 스타일

`node gen.mjs --list` 가 전부 보여 준다. key: editorial(편집 지면) ·
blueprint(청사진, 다크 기본) · sketch(손그림) · product(제품 화면) ·
modern(프리텐다드) · swiss(스위스 단색) · swissgrid(스위스 + 모눈) ·
terminal(터미널, 다크 하나) · pastel(파스텔 노트) · doc(호스트 문서의 토큰 따라감).

- default: **미정**. 정해지면 `lib/styles.mjs` 의 `DEFAULT_STYLE` 에 적는다.
- 스위스 둘의 강조색: 미정(빨강 · 호박 기각). 정해지면 두 스타일의 `accent`
  (라이트 · 다크)를 바꾼다.
- 한 페이지에 스타일 여럿을 섞어도 된다. `--css --style a,b` 로 한 번에 낸다.
- 공통 결정(2026-10-24): 코드 · 키 글꼴은 JetBrains Mono, 선 · 생명선 · 화살촉은
  본문 글자색, 되돌아가는 선은 `--blue`, LLM 선은 `--accent`.

## 스펙 어휘

- 상자 `kind`: (없음) 보통 · `lead` 주인공(강조색) · `gate` 분기 · `io` 입출력 ·
  `ext` 바깥 시스템(점선) · `exit` START/END 알약.
- 선 `kind`: (없음) 보통 · `back` 되돌아감(분기색, 통로로 돈다) · `cond` 조건(점선)
  · `accent` 강조(LLM) · `ret` 응답(시퀀스, 점선) · `both` 양방향(격자 지도).
  띄어쓰기로 합친다: `"back cond"`.
- 라벨은 선의 가장 긴 구간 가운데에 놓이고, 되돌아가는 선은 통로 쪽에 놓인다.

## 새 생성기 만들기

`lib/generators.mjs` 머리의 규칙 다섯을 따른다: 스펙엔 구조만 · 치수는 T(글꼴
크기)에서 · 노드는 `<g class="n" transform>` 안에서 (0,0) 기준 · 선은
`edgeEl()` 로 · `GENERATORS` 에 등록(draw · check · fit) 하고 `specs/` 에 예시.
새 class 가 필요하면 `lib/styles.mjs` 의 `DIAGRAM_CSS` 에 토큰만 참조하는 규칙을
더한다. 40~60 줄이면 된다.

## 검증

- `gen.mjs` 가 스펙을 검사한다: id 중복, 없는 id 참조, blocks 범위, 없는 레인.
  오류면 exit 1.
- 문서에 넣은 뒤엔 페이지 전체가 script 0 · 외부 요청 0 · 인라인 색 0 인지
  `rg -n '<script|https?://|fill="#|style="' 파일.html` 로 다시 확인한다.
- 미리보기 스크린샷으로 넘침 · 겹침을 본다. 글자 폭 추정은 넉넉하게 잡혀
  있지만 글꼴이 바뀌면 `lib/styles.mjs` 의 `textW · monoW` 계수를 맞춘다.
