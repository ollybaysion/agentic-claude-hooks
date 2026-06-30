# bash-guard 스타일 넛지 후보 (리서치)

`bash-guard`의 `STYLE_RULES`에 추가할 수 있는 셸 명령 스타일 넛지 후보 모음.
다중 에이전트 워크플로(후보 63개 → 67개 에이전트 적대적 검증)로 도출했고,
**추천 5 / 보류 12 / 기각 44**로 분류했다. 현재 적용 중인 규칙은 [README](README.md) 참고.

이 문서는 "무엇을 더 넣을지"의 의사결정 기록이다. 채택 시 해당 정규식을
`bash-guard.mjs`의 `STYLE_RULES`에 `[정규식, 이유]`로 옮긴다.

> **구현 상태**: 추천 1~5번(cat/head/tail→Read, sed -i→Edit, telnet→nc, htop/top→배치,
> cd&&→경로인자)과 `find → fd`(fd 설치 후, 기존 `find -name→rg`를 대체)가 모두
> `bash-guard.mjs`에 반영됨. `grep → rg`는 그 이전부터 적용 중. 아래 보류·기각 항목은 미반영.

## 판단 기준 — 에이전트 컨텍스트 적합성

이 명령들의 **출력은 사람이 아니라 LLM(Claude)이 소비**한다. 이 한 가지가 좋은 넛지와
나쁜 넛지를 가른다.

- **좋은 넛지**: 더 정확/완전/빠른 결과를 주거나, `.gitignore` 인식 등 에이전트에 유리.
  예) `grep → rg`, `find → fd`, 그리고 하네스 빌트인 도구(`Read`/`Edit`)로의 유도.
- **나쁜 넛지**: 사람 가독성용 도구. ANSI 색·페이저·아이콘·막대그래프를 추가해 모델
  파싱을 오염시킨다. 예) `bat`, `eza`, `dust`, `duf`, `procs`, `btop`, `delta`, `httpie`.

규약: 정규식은 세그먼트 맨 앞에 앵커(`/^\s*<cmd>\b/i`)를 걸어 `git grep`·`pgrep`·`egrep`·
`ripgrep`·파일명 속 단어 오탐을 피한다. `bash-guard.mjs`는 전체 명령과 `;`/`&&`/`||`/`|`
분리 세그먼트를 **둘 다** 검사한다.

## 중복도 — 내장 가이드와의 관계

Claude Code 자체에 이미 일부 넛지가 **내장**돼 있다. `Bash` 도구 설명은
"cat/head/tail/sed/awk/echo 대신 전용 도구를 써라"고 직접 권고하고, 빌트인 `Grep`/`Glob`
도구는 내부적으로 ripgrep을 쓴다. 따라서 일부 후보는 내장 가이드와 겹친다.

**겹친다고 가치가 없는 게 아니다** — 둘은 성격이 다르다.

- **내장 가이드** = 확률적 권고(프롬프트 한 줄). 대체로 따르지만 긴 세션·서브에이전트·
  드리프트에서 누락될 수 있다.
- **훅** = 결정론적 강제. 항상 발동하고, 바이패스 모드에서도, 모든 호출에 적용된다.

즉 중복 넛지의 가치는 "새로움"이 아니라 **"강제력"** 이다.

| 넛지 | 내장 중복도 | 훅의 역할 |
| --- | --- | --- |
| `cat/head/tail → Read` | 높음 (Bash 도구 설명이 직접 권고) | 확률적 가이드의 결정론적 강제 |
| `sed -i → Edit` | 높음 (sed 회피 명시) | 동일 |
| `grep → rg` (구현됨) | 높음 (`Grep` 빌트인 = ripgrep) | 동일 |
| `find -name → rg` (구현됨) | 중간 (`Glob`/`Grep` 도구 권고) | 동일 |
| `telnet → nc` | 없음 | 유일한 가이드 (net-new) |
| `htop/top → 배치` | 없음 | net-new |
| `cd && → 경로인자` | 약함 | 거의 net-new |
| `find → fd` | 없음 | net-new (설치 전제) |
| 안전 차단 (`rm -rf` 등, BLOCK) | 없음 | 유일한 강제 — 내장은 차단 안 함 |

해석:

- **중복 높음**: 내장과 겹침 → 훅은 "보강"(드리프트 방지 안전망). 안 넣어도 대체로
  동작하지만, 무인·바이패스·장기 세션에서 누락을 막는다.
- **중복 없음(net-new)**: 훅이 유일한 출처 → 안 넣으면 아무도 안 한다. **우선순위 높음.**
- **안전 차단**: 내장 가이드에 아예 없으므로 훅이 유일한 방어선.

**권고**: net-new 넛지를 우선 채택하고, 중복 높은 넛지는 결정론 강제가 필요한 환경
(바이패스 모드·무인 실행·서브에이전트 다수)에서 가치가 커진다는 점을 감안해 선택한다.

## 추천 — 바로 추가 (5종)

전부 빌트인(`Read`/`Edit`) 또는 설치 확인된 도구(`nc`/`top`/`ps`)로 향하므로 외부 설치가
필요 없다. 정규식은 검증을 거친 타이트한 패턴이다.

| # | from → to | 외부 도구 | 비고 |
| --- | --- | --- | --- |
| 1 | `cat`/`head`/`tail FILE` (보기) → `Read` 도구 | — | 가장 가치 높음 |
| 2 | `sed -i 's/…/…/' FILE` → `Edit` 도구 (또는 `sd`) | — | 변경 가시성·추적 |
| 3 | `telnet HOST PORT` → `nc -z -w3 HOST PORT` | — | telnet은 비-TTY hang |
| 4 | `htop`/`btop`/`gtop`/bare `top` → `top -b -n1` | — | 대화형 TUI hang 방지 |
| 5 | `cd X && CMD` → 도구 경로인자 | — | 다소 공격적, 선택적 |

### 붙여넣기용 규칙

```js
// 1) cat/head/tail FILE → Read  (파이프/리다이렉트/히어독/tail -f 자동 제외)
[/^\s*(?:cat|head|tail)(?=\s)(?!.*[<>|])(?!.*\s--?[fF])\s+\S/i,
 "파일 보기는 cat/head/tail 대신 Read 도구를 써라 — 줄번호와 offset/limit 페이지네이션을 주고 이미지/PDF/노트북도 읽으며, 하네스가 파일 상태를 추적한다."],

// 2) sed -i 인플레이스 치환 → Edit
[/^\s*sed\s+(?:-[a-z]*i|--in-place)/i,
 "sed -i 인플레이스 치환 대신 Edit 도구를 써라 — 변경이 diff로 보여 리뷰 가능하고 하네스가 파일을 추적한다. 다중 파일 스트림 치환이 꼭 필요하면 sd."],

// 3) telnet → nc -z  (telnet은 비-TTY 셸에서 입력 대기로 멈춤)
[/^\s*telnet\b/i,
 "telnet은 대화형이라 비-TTY 셸에서 멈춘다. 포트 점검은 nc -z -w3 HOST PORT (종료코드 0=열림/1=닫힘), 상세는 nc -vz."],

// 4) htop/btop/gtop/bare top → 배치 스냅샷  (top -b… 는 자기참조 면제)
[/^\s*(?:[hbga]top\b|top\b(?![^|;&]*\s-b))/i,
 "대화형 모니터(htop/top)는 TTY 없는 Bash에서 멈추거나 제어문자만 쏟아낸다. 스냅샷은 top -b -n1, CPU 상위는 ps aux --sort=-%cpu | head."],

// 5) cd X && CMD → 도구 경로인자  (서브셸 '(cd …)' 자연 면제)
[/^\s*cd\s+[^&|;]+&&/i,
 "'cd X && 명령' 대신 도구 경로인자를 써라 — rg PATH · git -C DIR · make -C DIR · ls DIR, 또는 절대경로. 에이전트는 호출 사이 cwd가 리셋된다."],
```

### 오탐·주의 메모

- **1 cat/head/tail**: `^\s*` 앵커로 명령 선두만 발동(`rg cat.txt`·`grep cat f` 미발동),
  `(?=\s)`로 `category`/`git cat-file` 차단. 파이프·리다이렉트·히어독·프로세스치환은
  `(?!.*[<>|])`로, `tail -f/-F/--follow`는 `(?!.*\s--?[fF])`로 제외. **순서 주의**:
  `bash-guard.mjs`는 BLOCK_RULES(`.env`/`.ssh`/`credentials`)를 STYLE보다 먼저 검사하므로
  민감파일을 Read로 잘못 유도하지 않는다 — 이 순서를 유지할 것.
- **2 sed -i**: 인플레이스 플래그를 `sed` 직후 첫 토큰으로만 인정 → 치환패턴 속
  `-i`(`s/foo-i/bar/`) 미매치. 스트림 `sed`(`sed 's/a/b/g'`, `sed -n …`)는 stdout을
  에이전트가 읽는 정당 용도라 의도적 비매치.
- **3 telnet**: `\b`로 `telnetd`(데몬) 미발동, `man/which/apt install telnet`은 선두 아님.
- **4 top**: `[hbga]top`은 항상 대화형이라 무조건 차단. `top\b` 뒤 `(?![^|;&]*\s-b)`로
  `top -b -n1`/`top -bn1`은 통과(순환 넛지 없음). `stop`/`systemctl stop`/`topic`은 회피.
- **5 cd &&**: 일상적으로 많이 쓰는 패턴이라 마찰 가능 → **선택적**. 소프트 넛지라 막진
  않지만 빼고 시작하는 것도 합리적. 서브셸 `(cd …)`·백그라운드 `&`는 미발동.

## 보류 — 조건부 (12종)

대부분 (a) 도구 미설치 게이팅, (b) 정규식 스코핑 전제, (c) 한계 가치/부분 중복이 결격
사유다. 채택하려면 조건을 먼저 충족할 것.

| from → to | 외부 도구 | 채택 조건 / 보류 이유 |
| --- | --- | --- |
| `find … -type f/d` → `fd -t f` | **fd (미설치)** | fd 선설치 필수(미설치 시 wedge). `find -name`은 이미 rg 규칙 담당 |
| `find … -type f` → `rg --files` | rg | `rg --files`는 gitignore/숨김 조용히 누락 → 이유에 `-uu --hidden` 명시 필요 |
| `find … -exec grep`/`\| xargs grep` → `rg` | rg | 개정 정규식(술어 룩어헤드) 필요. 교체 시 사실상 추천 등급 |
| `python …` → `python3 …` | — | 이 머신 `python`=py2.7이라 가치 있으나 출력개선이 아닌 동작 변경 |
| `ifconfig` → `ip -j addr` | ip | ifconfig 로컬 설치돼 안 깨짐 → 한계적. `ip -j`/`-br` 명시해야 실익 |
| `netstat -tlnp` → `ss -tlnp` | ss | 단순 현대화 위생. `-r/-i/-s`는 ss로 잘못 유도 → 스코프 한정 필수 |
| `cat \| wc -l` → `wc -l < file` | — | 출력 바이트 동일 → 실익 0. 최하 우선순위 |
| `find`(일반) → `fd` | **fd (미설치)** | 위 fd 항목과 동일 게이팅 + 화이트리스트 스코핑 전제 |
| `sed 's/…/…/'` → `sd` | **sd (미설치)** | `-i` 한정 안 하면 비파괴 stdout→파괴 in-place 위험 |
| `cat FILE \| grep` → `rg PAT FILE` | rg | 기존 grep→rg가 이미 deny → 부분중복. 메시지 정교화 가치만 |
| `ls \| grep` → `rg --files -g` | rg | 이미 deny되나 메시지가 내용검색 방향 → 방향교정 가치만, 니치 |
| `sed -i` → Edit (maybe판) | — | 추천 2번과 중복 — 추천판 채택 시 불필요 |

`find … -exec grep` 개정 정규식(채택 시):

```js
[/^\s*find\b(?![^|]*\s-(?:name|(?:a|c)?newer|[acm]time|[acm]min|size|perm|user|group|uid|gid|i?regex|inum|links|empty)\b)[^|]*(?:-exec\s+e?grep|\|\s*xargs(?:\s+-\S+)*\s+e?grep)\b/i,
 "'find … -exec grep'/'find … | xargs grep' 대신 'rg <패턴>'(필요시 -g '*.ext')를 써라 — 한 번에 재귀 검색하고 .gitignore를 인식하며 file:line:match로 출력한다."]
```

## 기각 (44종)

### A. 이미 구현됨 / 순수 중복

| 후보 | 사유 |
| --- | --- |
| `grep PAT FILE` → `rg` | `bash-guard.mjs`에 동일 `/^\s*grep\b/i` 이미 존재 |
| `find -name '*.ext'` → `rg --files -g` | 동일 규칙 이미 존재 |
| `grep -rn` → `rg` | 기존 `/^\s*grep\b/`의 진부분집합 |
| `cat\|grep`, `ls\|grep`, `grep\|wc` → `rg` | grep 세그먼트가 기존 규칙에 이미 걸림 |

### B. 사람용 도구 — 에이전트 부적합

출력 소비자가 LLM인데 **색 ANSI·페이저·아이콘·박스드로잉·막대그래프**를 더해 파싱을
오염시킨다. plain 원본이 이미 최적이라 교정할 안티패턴 자체가 없다.

| 후보 | 왜 안 되는가 |
| --- | --- |
| `cat`/`less` → `bat` | 줄번호 거터·파일헤더·구문강조 ANSI·페이저. 이득 0 |
| `ls` → `eza`/`exa` | Nerd-Font 아이콘(트랜스크립트 mojibake)·색·git컬럼 |
| `du` → `dust` | 유니코드 막대그래프(█▓░)·트리(├──) |
| `df` → `duf` | 박스드로잉 테두리·색 게이지 |
| `ps aux` → `procs` | ANSI 색·일부설정 pager(비-TTY hang) |
| `top`/`htop` → `btop`/`gtop` | 전체화면 TUI·연속 리드로우·키입력 대기. 방향 역행 |
| `git diff` → `delta` | 구문강조 ANSI·페이저. 비-TTY git diff는 이미 무색 → 무의미 |
| `curl` → `httpie` | 기본 헤더 출력·`--pretty=auto` 색. `curl -s`가 raw라 jq에 이상적 |

### C. 거짓 전제 / 해로움 / 스코프 밖

| 후보 | 기각 사유 |
| --- | --- |
| `man` → `--help` | man-db는 비-TTY에서 plain 출력. 섹션 2/3/5/7은 `--help` 없거나 틀림. 정보손실 |
| `which` → `command -v` | 출력 동일. 이식성 선호일 뿐 이득 0 |
| `pip install` → `python3 -m pip` | 의도적 스코프 밖(README §7). venv/conda 빗나감 위험 |
| `time CMD` → `hyperfine` | net-negative: 기본 10회 반복 → 부작용 명령에 치명. 노이즈 |
| `head/tail` → `Read` | head/tail은 `-n`로 이미 한정. `cmd\|head` 오버블록 위험 |
| `\| head` → `rg -m N` | 의미 불일치: 파일당 N개 ≠ 전체 N줄. 정당한 토큰캡을 오탐 |
| `kill -9` → `kill` | off-theme. 위험변종 `kill -9 -1`은 BLOCK_RULES가 이미 차단 |
| `sudo cat/ls` → sudo 제거 | 하드 deny 영구루프: 정당히 root 필요한 읽기를 막으면 wedge |
| `awk '{print $N}'` → `cut` | 해로움: `cut -d' '`는 연속공백 미압축 → 틀린 컬럼 |
| `tree -L 2` → `rg --files` | 의미 불일치(깊이제한 vs 무제한). 평면목록은 구조파악에 더 나쁨 |
| JSON 추출 → `jq` | 시작앵커 토큰 부재. 쓰기편집을 추출로 오인. 미설치 |
| 구조검색 → `ast-grep` | PreToolUse가 구조 vs 텍스트 의도 추론 불가. `sg` 충돌. 미설치 |

## 종합 권고

1. **즉시 추가(추천 1~4)**: 빌트인/설치확인 도구 + 검증된 타이트 정규식. 5번(`cd &&`)은
   마찰 고려해 선택적.
2. **cat→Read는 1규칙만** 채택(추천 1번이 head/tail까지 커버). BLOCK_RULES 우선평가
   순서 유지.
3. **fd 설치 후** `find → fd` 또는 `find -type f → rg --files`(개정 정규식) 추가 고려.
   설치 전엔 wedge 위험.
4. **`find -exec grep → rg`**는 개정 정규식(술어 룩어헤드 포함)으로 교체 시 사실상 추천 등급.
