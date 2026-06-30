# 마크다운 규칙 (markdownlint)

`lint` 훅이 `markdownlint-cli2`로 강제하는 마크다운 규칙 레퍼런스입니다. 번들
규칙 세트는 `config/.markdownlint-cli2.jsonc`에 있으며 `--config`로 적용되므로,
사용자 프로젝트의 설정과 무관하게 동작합니다.

## 범례

- ✅ 번들에서 켜짐 (`default: true`라 기본적으로 전부 켜짐)
- ⚙️ 켜져 있으나 커스터마이즈됨
- ❌ 끔
- – 기본 비활성 (옵션 규칙)

우리 번들은 **`MD013`만 끄고 나머지는 전부 켠** 상태이며, `MD003`, `MD004`,
`MD024`, `MD033` 네 가지만 취향대로 조정했습니다.

## 헤딩

| 규칙 | 이름 | 검사 내용 | 우리 |
| --- | --- | --- | --- |
| MD001 | heading-increment | 헤딩 레벨은 한 단계씩만 (h2 다음 h4 금지) | ✅ |
| MD003 | heading-style | 스타일 통일 — ATX (`#`) | ⚙️ atx |
| MD018 / MD019 | atx 공백 | `#` 뒤에 공백 정확히 1개 | ✅ |
| MD022 | blanks-around-headings | 헤딩 위아래 빈 줄 | ✅ |
| MD023 | heading-start-left | 헤딩은 줄 맨 앞(0열)에서 시작 | ✅ |
| MD024 | no-duplicate-heading | 헤딩 텍스트 중복 금지 | ⚙️ siblings_only |
| MD025 | single-h1 | 문서에 최상위 헤딩(h1) 하나만 | ✅ |
| MD026 | no-trailing-punctuation | 헤딩 끝에 `.` / `:` 금지 | ✅ |
| MD036 | no-emphasis-as-heading | 굵은 글씨를 헤딩 대용으로 쓰지 말 것 | ✅ |
| MD041 | first-line-h1 | 파일 첫 줄은 h1 | ✅ |
| MD043 | required-headings | 정해진 헤딩 구조 강제 | ⚙️ 경로 템플릿 |

## 리스트

| 규칙 | 이름 | 검사 내용 | 우리 |
| --- | --- | --- | --- |
| MD004 | ul-style | 불릿 마커 통일 — `-` | ⚙️ dash |
| MD005 | list-indent | 같은 레벨 항목의 들여쓰기 일관성 | ✅ |
| MD007 | ul-indent | 중첩 들여쓰기 칸 수 일관성 (기본 2) | ✅ |
| MD029 | ol-prefix | 번호 리스트 매기기 방식 일관성 | ✅ |
| MD030 | list-marker-space | 마커 뒤 공백 수 | ✅ |
| MD032 | blanks-around-lists | 리스트 위아래 빈 줄 | ✅ |

## 코드

| 규칙 | 이름 | 검사 내용 | 우리 |
| --- | --- | --- | --- |
| MD031 | blanks-around-fences | 코드펜스 위아래 빈 줄 | ✅ |
| MD038 | no-space-in-code | 인라인 코드 안 양끝 공백 금지 | ✅ |
| MD040 | fenced-code-language | 코드펜스에 언어 표기 필수 | ✅ |
| MD046 | code-block-style | 펜스 vs 들여쓰기 방식 통일 | ✅ |
| MD048 | code-fence-style | 백틱 vs 물결표 펜스 통일 | ✅ |

## 공백과 빈 줄

| 규칙 | 이름 | 검사 내용 | 우리 |
| --- | --- | --- | --- |
| MD009 | no-trailing-spaces | 줄 끝 공백 금지 | ✅ |
| MD010 | no-hard-tabs | 탭 대신 공백 | ✅ |
| MD012 | no-multiple-blanks | 빈 줄 연속 금지 | ✅ |
| MD047 | single-trailing-newline | 파일 끝 개행 정확히 1개 | ✅ |
| MD013 | line-length | 한 줄 길이 제한 (기본 80) | ❌ 끔 |

## 링크와 이미지

| 규칙 | 이름 | 검사 내용 | 우리 |
| --- | --- | --- | --- |
| MD034 | no-bare-urls | URL은 `<url>` 또는 `[텍스트](url)`로 감싸기 | ✅ |
| MD042 | no-empty-links | 빈 링크 `[]()` 금지 | ✅ |
| MD045 | no-alt-text | 이미지에 alt 텍스트 필수 | ✅ |
| MD051 | link-fragments | `#앵커`가 실제 헤딩을 가리키는지 | ✅ |
| MD052 / MD053 | reference-links | 참조 링크 정의 존재 / 사용 여부 | ✅ |
| MD059 | descriptive-link-text | "여기 클릭" 같은 모호한 링크 텍스트 금지 | ✅ |

## 인라인 서식

| 규칙 | 이름 | 검사 내용 | 우리 |
| --- | --- | --- | --- |
| MD037 | no-space-in-emphasis | `** 굵게 **`처럼 양끝 공백 금지 | ✅ |
| MD049 | emphasis-style | 기울임 `*` vs `_` 통일 | ✅ |
| MD050 | strong-style | 굵게 `**` vs `__` 통일 | ✅ |

## 기타

| 규칙 | 이름 | 검사 내용 | 우리 |
| --- | --- | --- | --- |
| MD033 | no-inline-html | 인라인 HTML 금지 | ⚙️ br/details/summary 허용 |
| MD035 | hr-style | 수평선 스타일 통일 (`---`) | ✅ |
| MD044 | proper-names | 고유명사 대소문자 강제 | – |
| MD055 / MD056 / MD058 | tables | 파이프 스타일 · 열 수 일치 · 표 주변 빈 줄 | ✅ |

## 전체 목록

여기서는 핵심 규칙만 다뤘습니다. 옵션을 포함한 전체(~50개)는 공식 레퍼런스를
참고하세요:
[markdownlint Rules.md](https://github.com/DavidAnson/markdownlint/blob/main/doc/Rules.md).
