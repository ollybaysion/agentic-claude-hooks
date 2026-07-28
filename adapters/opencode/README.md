# adapters/opencode

claude-hooks의 가드와 관측을 [opencode](https://opencode.ai)에서 쓰기 위한 어댑터
(이슈 #74). **설치·검증·트러블슈팅은 [`docs/opencode.md`](../../docs/opencode.md)**.

```bash
node adapters/opencode/install.mjs        # 전역 설치 → opencode 재시작
node adapters/opencode/test.mjs           # 어댑터 회귀 테스트
```

## 이 폴더의 것

| 파일 | 역할 |
| --- | --- |
| `plugin.js` | opencode 플러그인 본체. 훅 I/O만 담당 — 규칙은 갖고 있지 않다 |
| `install.mjs` | opencode 플러그인 디렉터리에 스텁(재export 한 줄)을 심는다 |
| `test.mjs` | 차단/통과/fail-open/재시도 억제 회귀 테스트 (opencode 없이 돈다) |

## 구조 — 왜 어댑터인가

판정은 CC 훅과 **같은 코어**를 부른다:

```text
core/bash-guard/decide.mjs ─┬─ core/bash-guard/bash-guard.mjs  (CC: stdin JSON → deny/ask JSON)
core/git-guard/decide.mjs  ─┴─ adapters/opencode/plugin.js     (opencode: hook args → throw)
```

규칙을 한 곳에서 고치면 두 하네스가 같이 바뀐다. 어댑터가 하는 일은 하네스별
차이를 흡수하는 것뿐이다:

| | Claude Code | opencode |
| --- | --- | --- |
| 차단 | `permissionDecision: "deny"` (stdout JSON + exit 0) | `tool.execute.before`에서 `throw` |
| 확인 요청 | `"ask"` | 채널 없음 → 기본은 차단 (`CLAUDE_HOOKS_OC_ASK=allow`로 통과) |
| 실행 모델 | 이벤트마다 프로세스 스폰 + stdin | 프로세스 안(Bun) 함수 호출, 상태 유지 가능 |
| 도구 이름 | `Bash` / `Write` / `Edit` / `MultiEdit` | `bash` / `write` / `edit` / `patch` |

opencode는 프로세스 안에서 살아 있으므로 CC 훅에는 없는 것도 할 수 있다 —
**세션별 재시도 카운터**(거부된 명령을 반복하면 문구가 강해진다)가 그 예다.

## 관측

`tool.execute.before/after` · `chat.message` · 세션 버스 이벤트를 CC와 같은
envelope으로 collector에 POST한다. 다른 점은 `runtime: "opencode"` 한 필드뿐이고,
수집기는 이걸 events 테이블의 컬럼으로 승격해(schema v8) sessions 탭에서 `OC`
배지로 보여준다. collector가 안 떠 있으면 detached로 띄운다(obs-lazy-start 역할).

## 규율

- **fail-open**: 모든 훅은 자기 오류를 삼킨다. 밖으로 나가는 예외는 **의도된 차단
  하나뿐**이다. 어댑터 버그가 세션을 막으면 안 된다.
- **관측은 hot path를 막지 않는다**: 이벤트 전송은 await 하지 않고, GuardDecision만
  2초 타임아웃으로 기다린다(그마저 실패해도 차단은 그대로 실행된다).
- **규칙을 여기에 쓰지 마라**: 새 규칙은 `core/*/decide.mjs`에. 그래야 CC에도 적용된다.
