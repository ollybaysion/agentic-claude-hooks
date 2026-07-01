# Python 린트 규칙 (ruff)

우리 lint 훅은 `.py`/`.pyi` 파일에 대해 `ruff check <file>`를 실행한다. ruff는 Rust로 작성된 초고속 파이썬 린터로, `flake8`·`isort`·`pyflakes`·`pycodestyle`·`pyupgrade`·`flake8-bugbear` 등 수십 개 도구의 규칙을 하나로 흡수했다. 각 규칙에는 `F401`, `E722` 같은 코드가 있고, 위반 시 코드·위치·설명을 출력한다.

포맷팅(들여쓰기·줄바꿈·따옴표 통일)은 검사하지 않는다 — 그건 `ruff format`(Black 호환)의 몫이고, 우리 훅은 **린트만** 한다. 즉 미사용 import, 미정의 이름, 문법 오류 같은 "코드로서 잘못된 것"에 집중하고, 각 프로젝트의 포맷 취향은 건드리지 않는다.

## 종료 코드와 훅 동작

- `0` = 위반 없음 → 통과.
- `1` = 하나 이상의 위반(파이썬 문법 오류 E999 포함) → 훅이 exit 2로 차단하고 출력을 Claude에게 피드백한다.
- `2` 이상 = 설정 파싱 실패·CLI 오류 등 → **인프라 문제로 보고 건너뛴다**(fail open). 예: 프로젝트 `pyproject.toml`이 깨져 있으면 exit 2 → 위반으로 오탐하지 않고 스킵.
- ruff가 설치되어 있지 않으면 해당 파일 타입을 건너뛴다(fail open).

eslint와 마찬가지로 **best-effort**다: 편집 중인 프로젝트의 `pyproject.toml`/`ruff.toml`/`.ruff.toml` 설정을 자동으로 존중하고, 설정이 없으면 ruff 내장 기본값으로 검사한다. `--fix`는 절대 쓰지 않는다(차단·피드백만, 자동 수정 없음).

## 기본으로 켜지는 규칙

ruff는 설정이 없을 때 **`F`(Pyflakes 전체) + `E4`·`E7`·`E9`(pycodestyle 오류의 핵심 일부)**만 켠다. 스타일 잔소리는 최소화하고 "거의 확실한 실수"만 잡는 보수적인 기본값이다. 대표적으로:

| 코드 | 잡는 것 |
| --- | --- |
| `F401` | 미사용 import |
| `F811` | 재정의로 가려진 정의 |
| `F821` | 미정의 이름 사용 |
| `F841` | 대입했지만 안 쓰는 지역 변수 |
| `F-string` 계열 | `%`/`.format`/f-string 오용, 중복 키 등 |
| `E711` / `E712` | `== None`, `== True` 비교 (→ `is None`, 불리언 직접) |
| `E722` | 맨몸 `except:` |
| `E9` / `E999` | 구문 오류(파싱 불가) |

`x=1` 같은 연산자 주변 공백(E225 등, `E2` 계열)은 **기본값에 없다** — 그건 포맷 영역이라 ruff format이 담당한다.

## 더 켜고 싶다면 (프로젝트 설정)

기본은 의도적으로 좁다. 더 엄격하게 하려면 프로젝트의 `pyproject.toml`에서 규칙군을 추가하면 되고, 우리 훅이 이를 그대로 따른다.

```toml
[tool.ruff.lint]
# 예: import 정렬(I), 코드 현대화(UP), 버그 유발 패턴(B),
#     단순화(SIM), 네이밍(N), 컴프리헨션(C4) 추가
select = ["E", "F", "I", "UP", "B", "SIM", "N", "C4"]
ignore = ["E501"]  # 줄 길이는 포매터에 위임
```

ruff가 흡수한 대표 규칙군(플러그인):

| 접두 | 출처 | 내용 |
| --- | --- | --- |
| `F` | Pyflakes | 논리 오류(미사용/미정의 등) — **기본 on** |
| `E` `W` | pycodestyle | PEP 8 오류/경고 — `E4/E7/E9`만 기본 on |
| `I` | isort | import 정렬·그룹화 |
| `UP` | pyupgrade | 구버전 문법 현대화 |
| `B` | flake8-bugbear | 흔한 버그·설계 함정 |
| `SIM` | flake8-simplify | 불필요하게 복잡한 코드 |
| `N` | pep8-naming | 네이밍 규칙 |
| `C4` | comprehensions | 컴프리헨션 개선 |
| `S` | flake8-bandit | 보안 취약 패턴 |
| `PL` | Pylint | Pylint 규칙 일부 |

전체 목록: <https://docs.astral.sh/ruff/rules/>

## 특정 규칙만 예외 처리하기

프로젝트 설정과 별개로, 코드 안에서 국소적으로 끌 수 있다.

```python
import os  # noqa: F401           한 줄에서 F401만 무시
import sys  # noqa                 한 줄의 모든 규칙 무시
# ruff: noqa                       파일 전체 무시
# ruff: noqa: F401                 파일 전체에서 F401만 무시
```

`# noqa`를 남발하지 않도록, ruff의 `RUF100`(설정에서 켠 경우)은 "실제로 아무것도 억제하지 않는" 불필요한 noqa를 다시 잡는다.

## 포맷도 강제하고 싶다면

우리 훅은 린트만 한다. Black 호환 포매터까지 강제하려면 `lint.mjs`의 `.py` 항목 옆에 한 줄을 더 추가하면 된다 (`.sh`가 shellcheck + shfmt를 함께 돌리는 것과 같은 구조).

```js
{ exts: [".py", ".pyi"], cmd: "ruff", args: (f) => ["format", "--check", f],
  fix: "Reformat to ruff's style (run `ruff format <file>` to apply)" },
```

`ruff format --check`는 포맷이 맞으면 0, 재포맷이 필요하면 1을 반환한다.

## 참고

- 규칙 전체 목록: <https://docs.astral.sh/ruff/rules/>
- 설정(`[tool.ruff]`): <https://docs.astral.sh/ruff/configuration/>
- noqa/인라인 억제: <https://docs.astral.sh/ruff/linter/#error-suppression>
