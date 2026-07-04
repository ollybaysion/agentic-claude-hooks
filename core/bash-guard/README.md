# bash-guard ✅

위험한 셸 명령을 **실행 전에 차단**하는 PreToolUse 훅. (10패턴 문서의 패턴 3 — "구조화된 Bash 검증기")

- **Event**: `PreToolUse` (matcher `Bash`)
- **Mechanism**: 위반 시 구조화된 `permissionDecision` 전달 (stdout JSON + exit 0) — 안전 위반은 `deny`, 파괴적 git(6번)은 `ask`(사용자 확인)
- **Requirement**: Node.js (PATH). 스타일 넛지는 대상 도구가 PATH에 있어야 함 — **rg, fd, nc**
- **Fail-open**: 훅 자체 오류는 차단하지 않음 (`failOpen`)
- **복합명령 분리**: `;` `&&` `||` `|` 줄바꿈으로 쪼개 각 조각 검사 → `echo x && rm -rf /` 우회 방지
- **rm 스캔은 argv 기반** (#36): quote-aware 렉서(`lib/shell-lex.mjs`, git-guard와 공유)로 세그먼트별 argv를 얻어, `rm` 토큰 **이후의 옵션 토큰에서만** `-r`/`-f` 의도를 읽는다. `git rm`은 면제(인덱스 삭제·복구 가능, git 삭제 정책은 git-guard 소관) — 커밋 메시지·하이픈 경로 조각이 세그먼트를 넘어 조합되는 오탐 없음
- **규칙 추가**: `bash-guard.mjs`의 `BLOCK_RULES`(안전·deny) / `ASK_RULES`(파괴적 git·ask) / `STYLE_RULES`(스타일 넛지·deny)에 `[정규식, 사유]` 한 줄 추가. 회귀 테스트는 `test.mjs`

> 구현됨: `bash-guard.mjs`. 1~5번 **차단(deny)**, 스타일 넛지 7종, 6번 파괴적 git **확인(ask)** 적용. 7번(전역설치) 차단은 범위 밖(보류). force-push/보호브랜치는 별도 git-guard 모듈 담당.

## 차단 규칙 (BLOCK — 실행 전 거부)

### 1. 파일/디스크 파괴

| 정규식 | 차단 이유 |
| --- | --- |
| `rm` argv에 `-r`계열 AND `-f`계열 | 재귀 강제 삭제 (`-rf`,`-fr`,`-r -f`,`--recursive --force`, `sudo`/`xargs`/`find -exec`/`bash -c`/`eval` 경유 포함). `git rm`·`--` 이후 피연산자는 면제 (#36) |
| `rm -rf /` / `~` / `.` / `*` | 루트·홈·현재디렉토리·와일드카드 통삭제 |
| `>\s*/dev/sd[a-z]` | 디스크에 직접 쓰기 |
| `dd\s+.*of=/dev/` | dd로 디스크 덮어쓰기 |
| `mkfs(\.\w+)?\s` | 파일시스템 포맷 |
| `shred\s` | 복구불가 삭제 |
| `:\(\)\s*\{.*\|\s*:\s*&.*\};:` | fork bomb |

### 2. 권한/소유권 무차별 변경

| 정규식 | 차단 이유 |
| --- | --- |
| `chmod\s+(-R\s+)?0?777` | 777 권한 |
| `chmod\s+-R\s+.*\s+/(\s\|$)` | 루트 재귀 권한 변경 |
| `chown\s+-R\s+.*\s+/(\s\|$)` | 루트 재귀 소유권 변경 |

### 3. 원격 코드 실행 (다운로드 → 셸)

| 정규식 | 차단 이유 |
| --- | --- |
| `curl\s+.*\|\s*(sudo\s+)?(ba)?sh` | curl \| sh |
| `wget\s+.*\|\s*(sudo\s+)?(ba)?sh` | wget \| sh |
| `curl\s+.*\|\s*sudo` | 다운로드 후 sudo |
| `(eval\|exec)\s+.*\$\(curl` | eval $(curl ...) |

### 4. 시스템 제어/전원

| 정규식 | 차단 이유 |
| --- | --- |
| `\b(shutdown\|poweroff\|halt\|reboot)\b` | 전원 차단/재부팅 |
| `\bsystemctl\s+(stop\|disable\|mask)\b` | 서비스 중단 |
| `\bkill(all)?\s+-9\s+-1` | 전체 프로세스 강제 종료 |

### 5. 자격증명/비밀 유출

| 정규식 | 차단 이유 |
| --- | --- |
| `(cat\|less\|head\|tail)\s+.*\.env(\s\|$)` | .env 노출 |
| `(cat\|less)\s+.*(\.ssh/\|id_rsa\|id_ed25519\|\.pem)` | SSH 키 노출 |
| `(cat\|less)\s+.*\.aws/credentials` | AWS 자격증명 노출 |
| `env\s*(\|\s*curl\|\|\s*nc)` | 환경변수 외부 전송 |
| `git\s+.*\|\s*curl` | 데이터 외부 전송 |

## 스타일 넛지 (STYLE — 차단 아님, 더 나은 도구로 유도)

안전 문제가 아니라 하우스 스타일. 같은 `deny` 메커니즘을 쓰지만, Claude가 사유를 읽고
**제안된 도구로 다시 실행**한다(차단이 아니라 교정 넛지). 세그먼트 **맨 앞 명령**에만
매칭(`^\s*`)해서 `git grep`·`pgrep`·`category`·파일명 속 단어 등 오탐을 피한다. 일부는 셸
명령 대신 **하네스 빌트인 도구(Read/Edit)** 로 유도한다.

| 넛지 | 유도 | 외부 도구 |
| --- | --- | --- |
| `grep` → `rg` | 빠르고 .gitignore 인식 | rg |
| `find … -exec grep` / `… \| xargs grep` → `rg` | 한 번에 재귀 검색 (`-mtime`/`-size`/`-perm` 등 메타필터 있으면 면제) | rg |
| `find` → `fd` | 간결·gitignore 인식 (`-exec`/`-mtime`/`-size` 등은 면제) | fd |
| `cat`/`head`/`tail FILE` → `Read` 도구 | 줄번호·offset/limit·멀티모달·파일추적 (파이프/`tail -f`/리다이렉트 면제) | — |
| `sed -i` → `Edit` 도구 | 변경이 diff로 보이고 추적됨 (스트림 sed는 면제) | — |
| `telnet HOST PORT` → `nc -z` | telnet은 비-TTY에서 hang | nc |
| `htop`/`top` → `top -b -n1` | 대화형 TUI hang 방지 (`top -b…`는 면제) | — |
| `cd X && CMD` → 경로인자 | `rg PATH`·`git -C`·`make -C`; cwd 리셋·권한프롬프트 회피 (서브셸 `(cd …)` 면제) | — |

> ⚠️ **외부 도구(rg/fd/nc)가 PATH에 있어야 함.** 미설치 환경이면 Claude가 대안 없이 막혀
> 멈출 수 있으니(wedge), 그런 머신에선 해당 규칙을 빼라. (`fd`는 Ubuntu에서 `fdfind`로
> 설치되므로 `fd` 심링크 필요.)
>
> 후보 분석(추천/보류/기각, 에이전트 적합성·중복도 관점)은
> [style-nudge-candidates.md](style-nudge-candidates.md) 참고.

## 확인 후 진행 규칙 (ASK — 실행 전 사용자 확인)

### 6. Git 파괴적 작업 ✅ (ask)

차단이 아니라 `permissionDecision:"ask"` — 가끔은 정당하므로 하드 deny 대신 사용자에게 확인을 받는다. `ASK_RULES`로 구현됨.

| 정규식 | 사유 |
| --- | --- |
| `\bgit\s+reset\b[^\|]*\s--hard\b` | 커밋 안 된 변경 손실 (`reset HEAD~1 --hard` 포함) |
| `\bgit\s+clean\b[^\|]*\s(?:-[a-z]*f\|--force)` | untracked 영구 삭제 (`clean -n` 드라이런은 면제) |
| `\bgit\s+(?:checkout\|restore)\s+(?:--\s+)?\.\s*$` | 워킹트리 전체 변경 폐기 (`checkout main`/경로 지정은 면제) |

> **force-push는 여기 없음** — `--force`/protected-branch 정책은 별도 **git-guard** 모듈 담당(경계 유지). git-guard 미배선 상태면 force-push는 현재 무방비. 켜려면 git-guard를 hooks.json에 배선할 것.

### 7. 패키지/전역 설치 (보류, 범위 밖)

| 정규식 | 사유 |
| --- | --- |
| `(npm\|yarn\|pnpm)\s+.*\b(--global\|-g)\b` | 전역 설치 |
| `pip\s+install\s+.*--break-system-packages` | 시스템 패키지 강제 |
| `sudo\s+(apt\|yum\|dnf\|pacman)\s+(remove\|purge)` | 시스템 패키지 제거 |

## 적용 결정 (확정)

- 메커니즘: 구조화 `permissionDecision` — 안전(1~5) `deny`, 파괴적 git(6) `ask` (`lib/hook-io.mjs`의 `denyPreToolUse`/`askPreToolUse`)
- 범위: **1~5 차단**, **6 확인(ask)** 적용. 7(전역설치)은 보류
- 스캔 순서: 안전 deny → 파괴적-git ask → 스타일 nudge → file-view (안전이 항상 우선)
- 스타일 넛지 7종 (rg/fd/nc 및 빌트인 Read/Edit로 유도)
- force-push/보호브랜치는 git-guard 모듈 담당(경계 유지)
- 모든 정규식은 대소문자 무시(`i` 플래그) 적용

## 로컬 테스트

```bash
cd claude-hooks
# 회귀 테스트 일괄 실행 (#36 오탐 케이스 + rm/규칙 전반)
node core/bash-guard/test.mjs
# 차단 (deny JSON + exit 0)
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' | node core/bash-guard/bash-guard.mjs
# 우회 시도도 차단
echo '{"tool_name":"Bash","tool_input":{"command":"echo hi && rm -rf ~"}}' | node core/bash-guard/bash-guard.mjs
# 스타일 넛지 (deny + rg/fd/Read 유도)
echo '{"tool_name":"Bash","tool_input":{"command":"find . -type f"}}' | node core/bash-guard/bash-guard.mjs
# 정상 통과 (무출력 + exit 0)
echo '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}' | node core/bash-guard/bash-guard.mjs
# 범위 밖 통과
echo '{"tool_name":"Read","tool_input":{"file_path":"/x"}}' | node core/bash-guard/bash-guard.mjs
```
