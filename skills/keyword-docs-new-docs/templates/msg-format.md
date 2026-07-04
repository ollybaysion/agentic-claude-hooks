<!--
category: msg-format
인덱스: 프로젝트 .claude/context-docs.msg-format.json · 개인 지정 ~/.claude/context.json의 params.index · 번들 context-docs/msg-format.json
저장 경로: msg/<커맨드명 소문자 kebab>.md — 레이어별 위치: 프로젝트 .claude/docs/ · 개인 지정 <인덱스 폴더>/ · 번들 context-docs/docs/ (예: CMD_START_LOT → msg/cmd-start-lot.md)
필수 슬롯: 커맨드명, 방향, 용도, 필드표
선택 슬롯: 응답/타임아웃, 거부 조건, 예시 페이로드, 에러코드표
키워드 기본값: 커맨드명 소문자 그대로 (예: cmd_start_lot) — 밑줄 식별자는 한 토큰으로 매치됨
precision 기본값: 1
채우기 규칙: {{...}} 안의 지시대로 채운다. "없으면 삭제" 표시가 있는 줄은 해당 없을 때 통째로 지운다.
이 주석 블록은 문서 생성 시 제거한다.
-->

# {{커맨드명 — 코드 표기 그대로, 예: CMD_START_LOT}}

{{방향: Host → Equipment 또는 Equipment → Host}}. {{용도 한 줄 — 무엇을 지시/보고하는가}}.
응답: {{응답 커맨드명 + 타임아웃, 예: CMD_START_LOT_ACK (3s) — 응답이 없으면 "없음(단방향)"}}

| # | 필드 | 타입 | 필수 | 설명 |
| --- | --- | --- | --- | --- |
| 1 | {{필드명}} | {{타입(길이)}} | {{✓ 또는 -}} | {{한 줄 설명}} |
| 2 | {{코드의 메시지 정의 순서 그대로, 필드 수만큼 행 반복}} | | | |

주의: {{거부/NAK 조건 — Interlock, 상태 제약 등. 없으면 이 줄 삭제}}

---

## 예시 페이로드

{{선택 — 실제 송수신 예 1개. 여기부터는 1200자 컷 아래라 잘려도 무방}}

## 에러코드

{{선택 — 전체 에러코드 표}}
