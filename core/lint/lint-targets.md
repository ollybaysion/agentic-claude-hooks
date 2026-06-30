# Lint 타겟 후보 (리서치)

`lint` 훅에 추가할 만한 파일타입 린터/포매터를 조사·검증한 결과다. 76개 도구를
7개 카테고리로 조사하고, fit이 높은 54개를 웹으로 적대 검증했다 (검증 결과를 원
조사 주장보다 우선).

## 선정 기준

1. **standalone** — 프로젝트 config 없이도 동작해야 한다 (eslint/stylelint처럼
   config가 없으면 fail-open하는 도구는 약한 적합).
2. **무-sudo 설치** — `npm i -g`, `pipx` / `pip --user`, 또는 `~/.local/bin`에
   떨어뜨리는 정적 바이너리.
3. **명확한 exit 코드** — 0=clean, nonzero=위반. eslint의 `2=fatal`처럼
   인프라/위반을 구분해야 하는 특수 코드는 별도 처리.
4. **per-edit로 충분히 빠름** (매 편집마다 실행).

## Tier 1 — 강력 추천 (standalone + 쉬운 무-sudo 설치)

| 파일타입 | 도구 | 설치(무-sudo) | exit | 매칭 | 비고 |
| --- | --- | --- | --- | --- | --- |
| .py | ruff | `pipx install ruff` | 1=위반 / 2=fatal | 확장자 | ms급 zero-config. flake8·isort·pyflakes 흡수. `--fix` 금지 |
| .css .scss .less .html .vue | prettier | 이미 보유 | 1=포맷차 / 2=파싱 | 확장자 | 신규 설치 0. 디스패치 한 줄로 확보 |
| .toml | taplo | `npm i -g @taplo/cli` | nonzero=위반 | 확장자 | `taplo fmt --check` (서브커맨드 필수) |
| .yaml .yml | yamllint | `pipx install yamllint` | 1=error | 확장자 | `--strict` 빼고. prettier와 보완 |
| Dockerfile | hadolint | 정적 바이너리 | 1=위반 | 파일명 | zero-config. RUN 내부 shellcheck 연동 |
| .github/workflows | actionlint | 정적 Go 바이너리 | 1=위반 / 2,3=인프라 | 경로 | 기존 shellcheck가 run 검사 강화 |
| .sh .bash | shfmt | 정적 Go 바이너리 | nonzero=차이/구문 | 확장자 | `shfmt -d`. shellcheck와 보완(포맷) |
| .proto | protolint | `npm i -g protolint` | 1=위반 / 2=인프라 | 확장자 | `protolint lint`. zero-config |
| .rs | rustfmt | `rustup component add rustfmt` | 1=차이 | 확장자 | `--check --edition 2021` |
| .lua | StyLua | 정적 바이너리 | 1=재포맷 | 확장자 | `--check`. diff가 stdout |
| .c .cpp .h | clang-format | `pipx install clang-format` | 1=차이 | 확장자 | `--dry-run --Werror` 필수 |
| .go | gofmt | Go tarball | 특수 | 확장자 | `gofmt -l`: stdout 비고 exit 0이면 clean |
| .html | htmlhint / SuperHTML | npm / 정적 Zig | 1=위반 | 확장자 | 얕은 린트 / 더 엄격한 구조검증 |

Python 정리: ruff 하나가 flake8·isort·pyflakes·pycodestyle을 흡수하므로 ruff
단일 채택을 권장한다. 보안까지 원하면 bandit을 추가한다.

## Tier 2 — best-effort (config 의존 / 무거움)

| 파일타입 | 도구 | 한계 |
| --- | --- | --- |
| .go | golangci-lint, staticcheck | 패키지 전체 타입체크 → 느림, 미완성 코드 오block. CI용 |
| .sql | sqlfluff | `--dialect ansi` 핀 필수, 이 세트서 가장 느림 |
| .swift | swiftlint | Linux 무-sudo 경로 없음 (macOS-first) |
| .rb | RuboCop | 기본룰 시끄러움(config 사실상 필요), Ruby 기동 느림 |
| .php | phpcs, php-cs-fixer | PHP 런타임 필요 (보통 sudo) |
| .xml .svg | xmllint | well-formed만. 무-sudo는 conda/선설치 의존 |
| k8s yaml | kubeconform | 첫 사용 시 스키마 네트워크 fetch, 평범 yaml과 충돌 |
| OpenAPI | vacuum, redocly | 평범 yaml/json과 충돌 → 내용 감지 필요 |
| .tf | terraform fmt | ~80MB CLI를 포맷용으로만 |

## Tier 3 — 프로스 / 맞춤법 (.md .txt 한정)

| 도구 | 설치 | exit | 비고 |
| --- | --- | --- | --- |
| codespell | `pipx install codespell` | 65=위반 / 64=skip | 최고 적합. 자체 사전, 저오탐, 빠름 |
| cspell | `npm i -g cspell` | 1=위반 | 실제 맞춤법, 식별자 오탐 → md/txt만 |
| proselint | `pipx install proselint` | 1=위반 | 영어 프로스 품질(중복·클리셰) |

## 제외 (부적합)

- Vale, textlint — config 필수, 빌트인 룰 0개.
- mypy, clang-tidy, clippy — 전 프로젝트 타입체크, 단일파일 무의미, 느림.
- pylint — exit 비트OR(분류 불가), 느림, 소음 (ruff가 대체).
- stylelint, svglint — config 없으면 no-op.
- buf, spectral — 워크스페이스/ruleset 필요 (protolint / vacuum 사용).
- Bats — 린터 아님(테스트 러너), 코드 실행.

## 구현 메모

확장자가 아닌 매칭이 필요해 디스패처 수정이 드는 것:

- 파일명 매칭: hadolint(`Dockerfile`), checkmake(`Makefile`).
- 경로 매칭: actionlint(`.github/workflows/`), kubeconform(`k8s/`).
- 내용 감지: OpenAPI는 평범 yaml/json과 충돌 → top-level `openapi:` 키 감지 필요.

순수 레지스트리 한 줄(확장자 매칭)로 끝나는 것:

- 거의 bare 호출: yamllint, hadolint, htmlhint, codespell, proselint.
- 플래그 고정: `ruff check`, `prettier --check`, `taplo fmt --check`,
  `shfmt -d`, `clang-format --dry-run --Werror`, `sqlfluff lint --dialect ansi`.

exit 코드 분류가 필요한 것:

- `2=fatal → skip`: ruff, bandit, actionlint, protolint, sqlfluff.
- 역방향/특수: terraform fmt(`2,3=block / 1=skip`), codespell(`65/64`),
  gofmt(stdout로 판별), StyLua(diff=stdout).

## 최종 추천 Top 5 (가성비 순)

1. **ruff** (.py) — 비어있는 최대 공백을 ms급·zero-config로 메움. 최고 레버리지.
2. **prettier 확장** (css/scss/less/html/vue) — 신규 설치 0, 디스패치 한 줄.
3. **shfmt** (.sh) — 기존 shellcheck와 보완(포맷), 정적 바이너리.
4. **hadolint + actionlint** — 정적 바이너리·zero-config, 기존 shellcheck가 무료
   강화 (파일명·경로 매칭 필요).
5. **taplo** (.toml) — Rust·빠름·zero-config.

추가 한 가지: **codespell** (.md/.txt) — 전역 per-edit 차단에 가장 안전한 프로스
도구.
