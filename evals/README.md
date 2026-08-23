# evals — 스킬 라우팅 측정

스킬이 **의도한 상황에 실제로 발동하는지**를 측정한다. 라우팅 표면은 `SKILL.md`
frontmatter의 `description` 텍스트뿐이라, 문구를 고칠 때마다 추측 대신 돌려서 확인한다.

## 왜 있나

`html-doc`과 `svg-figure`는 트리거 어휘가 겹친다 — 둘 다 "HTML로 만들어줘"로 불린다.
경계는 한 줄이다:

> **도형이 문서 안의 한 요소면 html-doc, 도형 자체가 산출물 전부면 svg-figure.**

`routing/` 아래 케이스가 그 경계를 양쪽에서 찌른다. `figure-*`는 svg-figure로,
`doc-*`는 html-doc으로 가야 하고, `doc-with-diagram`은 **문서 안에 다이어그램이 있는**
경계 케이스다.

## 돌리기

```bash
claude plugin eval --ablation none --case 'routing-*' .
```

- 판정은 `tool_used` 결정론 그레이더라 LLM 심사 비용이 붙지 않는다.
- 케이스마다 그레이더 두 개다: 맞는 스킬이 **발동**(`min: 1`), 반대쪽이 **미발동**(`max: 0`).
- 오라우팅이 나오면 고칠 곳은 스킬 본문이 아니라 **두 `description`**이다.

## 주의

`claude plugin eval`은 **조직 단위 early access**다. 열려 있지 않으면
``plugin eval` is currently in early access``를 출력하고 exit 1 한다 — 명령이 없는 게
아니라 권한이 없는 것이다. 열리기 전까지 이 스위트는 실행되지 않은 상태로 남는다.
