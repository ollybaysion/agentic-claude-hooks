# 경로별 Markdown 템플릿 추가하기

`lint` 훅은 편집된 파일의 **경로**를 보고, 그 경로에 맞는 markdownlint config를
골라 적용할 수 있습니다. 대표 용도는 특정 문서 종류(ADR, 포스트모템 등)에
**필수 제목 구조(MD043)**를 강제하는 것이지만, 임의 규칙 오버라이드에도 쓸 수
있습니다 (예: 특정 폴더만 MD013 켜기).

## 구성 요소

| 파일 | 역할 |
| --- | --- |
| `config/rules.jsonc` | 공유 base 규칙 (평문 markdownlint config) |
| `config/.markdownlint-cli2.jsonc` | base 래퍼 — 매칭 안 된 일반 문서가 사용 |
| `config/templates/<name>.jsonc` | 템플릿 — base를 `extends`하고 규칙을 더함 |
| `lint.mjs`의 `MD_TEMPLATES` | 경로 패턴 → 템플릿 파일 매핑 (분기) |

동작: 훅이 경로로 템플릿을 고르고(`MD_TEMPLATES`), 그 템플릿이 base를
`extends`로 물려받습니다. `--config`에는 항상 파일 1개만 넘어가고, base 상속은
파일 안의 `extends`가 처리합니다.

## 추가 절차 (2곳 편집)

### 1. 템플릿 config 파일 만들기

`config/templates/`에 새 파일을 만들고, base를 상속한 뒤 원하는 규칙만 더합니다.

```jsonc
// config/templates/postmortem.jsonc
{
  "config": {
    "extends": "../rules.jsonc",
    "MD043": {
      "headings": ["*", "## 요약", "## 타임라인", "## 원인", "## 재발 방지"]
    }
  }
}
```

`extends`는 반드시 `../rules.jsonc` (base)를 가리키게 하세요. 그래야 기존 규칙
(MD013 off, MD040 on 등)이 그대로 유지되고 이 파일의 규칙만 얹힙니다.

### 2. `lint.mjs`의 `MD_TEMPLATES`에 한 줄 추가

```js
const MD_TEMPLATES = [
  { match: (p) => /(^|\/)(docs\/)?adr\//i.test(p),  config: "templates/adr.jsonc" },
  { match: (p) => /\/postmortem\//i.test(p),         config: "templates/postmortem.jsonc" },
];
```

- `match`는 경로를 받아 `true`/`false`를 주는 함수입니다 (정규식 자유).
- **위에서 첫 매칭이 이깁니다.** 구체적인 패턴을 위에 두세요.
- 아무것도 매칭 안 되면 base config가 쓰여, 일반 문서는 영향이 없습니다.

## MD043 제목 문법

`headings` 배열은 문서의 **모든 제목을 순서대로** 맞춰봅니다. 각 원소는:

| 원소 | 의미 |
| --- | --- |
| `"## 결정"` | 정확히 그 텍스트의 제목이 그 자리에 있어야 함 |
| `"*"` | 임의 제목 0개 이상 (예: 제목 h1을 흡수) |
| `"+"` | 임의 제목 1개 이상 |

예) `["*", "## 맥락", "## 결정", "## 결과"]` = 앞에 아무 제목(보통 h1 제목)이 온
뒤, 마지막이 `맥락 → 결정 → 결과` 순서여야 함.

## 로컬 테스트

합성 이벤트를 stdin으로 흘려 직접 확인합니다.

```bash
# 매칭되는 경로로 잘못된 문서를 만들어 차단(exit 2) 확인
echo '{"tool_name":"Write","tool_input":{"file_path":"/tmp/docs/adr/x.md"}}' \
  | node core/lint/lint.mjs ; echo "exit=$?"
```

확인할 것: 매칭 경로의 위반 문서 → exit 2 + MD043, 올바른 문서 → exit 0,
매칭 안 되는 경로 → 기존과 동일.

## 배포

템플릿/규칙 변경은 런타임 동작을 바꾸므로 **버전을 올려야** 캐시가 갱신됩니다.

```bash
# plugin.json 과 marketplace.json 의 version 을 함께 올린 뒤
git commit -am "..."; git push
claude plugin marketplace update claude-hooks
claude plugin update claude-hooks@claude-hooks   # 적용엔 재시작 필요
```
