# bash-guard ✅

위험한 셸 명령을 **실행 전에 차단**하는 PreToolUse 훅. (10패턴 문서의 패턴 3 — "구조화된 Bash 검증기")

- **Event**: `PreToolUse` (matcher `Bash`)
- **Mechanism**: 위반 시 구조화된 `permissionDecision:"deny"` + 타입화된 이유를 Claude에 전달 (stdout JSON + exit 0)
- **Requirement**: Node.js (PATH)
- **Fail-open**: 훅 자체 오류는 차단하지 않음 (`failOpen`)
- **복합명령 분리**: `;` `&&` `||` `|` 줄바꿈으로 쪼개 각 조각 검사 → `echo x && rm -rf /` 우회 방지
- **규칙 추가**: `bash-guard.mjs`의 `BLOCK_RULES`에 `[정규식, 사유]` 한 줄 추가

> 구현됨: `bash-guard.mjs`. 아래는 적용 중인 규칙 모음. 1~5번 **차단**, 6~7번은 범위 밖(보류).

## 차단 규칙 (BLOCK — 실행 전 거부)

### 1. 파일/디스크 파괴
| 정규식 | 차단 이유 |
|---|---|
| `rm` + (`-r`계열 AND `-f`계열) | 재귀 강제 삭제 (`-rf`,`-fr`,`-r -f`,`--recursive --force` 모두) |
| `rm -rf /` / `~` / `.` / `*` | 루트·홈·현재디렉토리·와일드카드 통삭제 |
| `>\s*/dev/sd[a-z]` | 디스크에 직접 쓰기 |
| `dd\s+.*of=/dev/` | dd로 디스크 덮어쓰기 |
| `mkfs(\.\w+)?\s` | 파일시스템 포맷 |
| `shred\s` | 복구불가 삭제 |
| `:\(\)\s*\{.*\|\s*:\s*&.*\};:` | fork bomb |

### 2. 권한/소유권 무차별 변경
| 정규식 | 차단 이유 |
|---|---|
| `chmod\s+(-R\s+)?0?777` | 777 권한 |
| `chmod\s+-R\s+.*\s+/(\s\|$)` | 루트 재귀 권한 변경 |
| `chown\s+-R\s+.*\s+/(\s\|$)` | 루트 재귀 소유권 변경 |

### 3. 원격 코드 실행 (다운로드 → 셸)
| 정규식 | 차단 이유 |
|---|---|
| `curl\s+.*\|\s*(sudo\s+)?(ba)?sh` | curl \| sh |
| `wget\s+.*\|\s*(sudo\s+)?(ba)?sh` | wget \| sh |
| `curl\s+.*\|\s*sudo` | 다운로드 후 sudo |
| `(eval\|exec)\s+.*\$\(curl` | eval $(curl ...) |

### 4. 시스템 제어/전원
| 정규식 | 차단 이유 |
|---|---|
| `\b(shutdown\|poweroff\|halt\|reboot)\b` | 전원 차단/재부팅 |
| `\bsystemctl\s+(stop\|disable\|mask)\b` | 서비스 중단 |
| `\bkill(all)?\s+-9\s+-1` | 전체 프로세스 강제 종료 |

### 5. 자격증명/비밀 유출
| 정규식 | 차단 이유 |
|---|---|
| `(cat\|less\|head\|tail)\s+.*\.env(\s\|$)` | .env 노출 |
| `(cat\|less)\s+.*(\.ssh/\|id_rsa\|id_ed25519\|\.pem)` | SSH 키 노출 |
| `(cat\|less)\s+.*\.aws/credentials` | AWS 자격증명 노출 |
| `env\s*(\|\s*curl\|\|\s*nc)` | 환경변수 외부 전송 |
| `git\s+.*\|\s*curl` | 데이터 외부 전송 |

## 확인 후 진행 규칙 (ASK — 보류, 1차 범위 제외)

### 6. Git 파괴적 작업
| 정규식 | 사유 |
|---|---|
| `git\s+push\s+.*--force(?!-with-lease)` | 강제 푸시 (`--force-with-lease`는 허용) |
| `git\s+reset\s+--hard` | 작업물 손실 |
| `git\s+clean\s+-[a-z]*f[a-z]*d` | untracked 강제 삭제 |
| `git\s+checkout\s+\.\s*$` | 전체 변경 폐기 |

### 7. 패키지/전역 설치
| 정규식 | 사유 |
|---|---|
| `(npm\|yarn\|pnpm)\s+.*\b(--global\|-g)\b` | 전역 설치 |
| `pip\s+install\s+.*--break-system-packages` | 시스템 패키지 강제 |
| `sudo\s+(apt\|yum\|dnf\|pacman)\s+(remove\|purge)` | 시스템 패키지 제거 |

## 적용 결정 (확정)
- 차단 메커니즘: **(B) 구조화 `permissionDecision:"deny"`** (`lib/hook-io.mjs`의 `denyPreToolUse`)
- 1차 범위: **1~5 차단**, 6~7은 제외(나중에 ASK로 확장)
- 모든 정규식은 대소문자 무시(`i` 플래그) 적용

## 로컬 테스트
```bash
cd claude-hooks
# 차단 (deny JSON + exit 0)
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}' | node core/bash-guard/bash-guard.mjs
# 우회 시도도 차단
echo '{"tool_name":"Bash","tool_input":{"command":"echo hi && rm -rf ~"}}' | node core/bash-guard/bash-guard.mjs
# 정상 통과 (무출력 + exit 0)
echo '{"tool_name":"Bash","tool_input":{"command":"ls -la"}}' | node core/bash-guard/bash-guard.mjs
# 범위 밖 통과
echo '{"tool_name":"Read","tool_input":{"file_path":"/x"}}' | node core/bash-guard/bash-guard.mjs
```
