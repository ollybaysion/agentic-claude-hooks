# HTML 검증 규칙 (html-validate)

우리 lint 훅은 `.html`/`.htm` 파일에 대해 `html-validate --config <번들 설정> <file>`을 실행한다. html-validate는 브라우저처럼 문서를 파싱한 뒤 **HTML 표준 준수·구조 정합성·접근성(WCAG)**을 규칙 단위로 검사하는 정적 분석기다. `SC2086` 같은 셸 규칙과 마찬가지로 각 규칙에는 `wcag/h37`, `close-order` 같은 ID가 있고, 위반 시 그 ID와 함께 위치·설명·문서 링크를 출력한다.

포맷팅(들여쓰기·줄바꿈)은 검사하지 않는다 — 그건 prettier의 몫이고, html-validate는 "구조·의미·접근성이 올바른가"에 집중한다. 따라서 prettier(포맷)와 html-validate(검증)는 경쟁이 아니라 보완 관계다.

## 종료 코드와 훅 동작

- `0` = 오류 없음 → 통과.
- `1` = 하나 이상의 오류 → 훅이 exit 2로 차단하고 출력 전체를 Claude에게 피드백한다 (자동 수정 없음).
- html-validate가 설치되어 있지 않으면 그 파일 타입은 건너뛴다 (fail open).

번들 설정에 `"root": true`를 두어 프로젝트의 `.htmlvalidate.json`을 병합하지 않는다. 그렇게 하지 않으면 프로젝트 쪽 설정이 깨져 있을 때 도구가 exit 1로 크래시하는데, 이는 진짜 위반과 종료 코드가 같아 오탐 차단을 유발하기 때문이다.

## 우리가 쓰는 규칙 세트

번들 설정은 공식 프리셋 **`html-validate:recommended`**를 확장하고, 딱 하나만 끈다.

```json
{
  "root": true,
  "extends": ["html-validate:recommended"],
  "rules": {
    "void-style": "off"
  }
}
```

- **`void-style` off**: `recommended`는 void 요소를 슬래시 없는 정규형(`<img>`, `<br>`, `<meta>`)으로 강제하고 `<img />` 같은 self-close를 오류로 본다. 두 표기 모두 유효한 HTML5이고 self-close는 매우 흔해서, 이 규칙은 정합성 이득 없이 마찰만 크므로 껐다 (markdown에서 줄 길이 규칙 MD013을 끈 것과 같은 이유). 나머지 self-close 관련 정합성은 `no-self-closing`(비 void 요소 `<div/>` 금지)과 `void-content`(void 요소에 내용 금지)가 계속 잡는다.

아래는 `recommended`가 켜는 규칙을 범주별로 정리한 것이다 (모두 기본 error, 표시된 것만 예외).

## 구조 · 유효성

문서가 실제로 파싱 가능하고 HTML 콘텐츠 모델을 지키는지 검사한다.

| 규칙 | 잡는 것 |
| --- | --- |
| `close-order` | 여닫는 태그 순서 불일치·미종료 (`<div><p></div>`) |
| `close-attr` | 닫는 태그에 속성 (`</div class>`) |
| `no-implicit-close` | 다른 요소/문서 끝에 의해 암묵적으로 닫히는 요소 → 명시적으로 닫아라 |
| `no-self-closing` | void가 아닌 요소의 self-close (`<div/>`, `<span/>`) |
| `void-content` | void 요소 안의 내용 (`<img>text</img>`) |
| `element-permitted-content` | 허용되지 않는 자식 (`<ul>` 직속 텍스트 등) |
| `element-permitted-occurrences` | 중복 불가 요소 반복 (`<title>` 2개) |
| `element-permitted-order` | 자식 요소 순서 위반 |
| `element-permitted-parent` | 잘못된 부모 아래의 요소 |
| `element-required-ancestor` | 필수 조상 누락 (`<li>`가 `<ul>`/`<ol>` 밖) |
| `element-required-attributes` | 필수 속성 누락 (`<html lang>` 등) |
| `element-required-content` | 필수 내용 누락 (`<head>`에 `<title>`) |
| `element-name` | 커스텀 요소 이름 규칙 위반 |
| `no-dup-attr` | 같은 요소에 중복 속성 |
| `no-dup-id` | 문서 내 중복 `id` |
| `no-dup-class` | 같은 `class`에 중복 토큰 |
| `valid-id` | `id`/`for` 값 형식 유효성 |
| `unrecognized-char-ref` | 알 수 없는 문자 참조 (`&foo;`) |
| `no-raw-characters` | 이스케이프 안 된 `<` `>` `&` |
| `form-dup-name` | 폼 안의 중복 컨트롤 `name` |
| `map-dup-name` / `map-id-name` | `<map>` 이름/id 문제 |
| `doctype-html` | 레거시/비표준 doctype (`<!DOCTYPE html>`만 허용) |

## 표기 · 인용 · 공백

| 규칙 | 잡는 것 |
| --- | --- |
| `element-case` | 요소명 대소문자 (여는·닫는 태그 casing 불일치 포함) |
| `attr-case` | 속성명 대소문자 |
| `attr-quotes` | 속성값 따옴표 규칙 |
| `attr-delimiter` | `=` 주변 등 속성 구분자 |
| `attr-spacing` | 속성 사이 공백 |
| `attribute-boolean-style` | 불리언 속성 표기 (`disabled` vs `disabled="disabled"`) |
| `attribute-empty-style` | 빈 속성 표기 (`foo=""` vs `foo`) |
| `doctype-style` | doctype 대소문자 스타일 |
| `no-trailing-whitespace` | 줄 끝 공백 |
| `no-utf8-bom` | UTF-8 BOM |
| `void-style` | (우리는 **off**) void 요소 슬래시 스타일 |

## 속성 · 값

| 규칙 | 잡는 것 |
| --- | --- |
| `attribute-allowed-values` | 허용되지 않는 속성값 (`type="foo"`) |
| `attribute-misuse` | 문맥상 잘못 쓰인 속성 |
| `input-attributes` | `<input>` 속성 조합 오류 |
| `no-implicit-input-type` | `<input>`에 `type` 명시 요구 |
| `no-implicit-button-type` | `<button>`에 `type` 명시 요구 |
| `no-deprecated-attr` | 폐기된 속성 |
| `deprecated` | 폐기된 요소 (`<center>`, `<font>`) |
| `deprecated-rule` | (warn) 폐기된 규칙 사용 |
| `no-conditional-comment` | IE 조건부 주석 |
| `no-inline-style` | 인라인 `style` 속성 |
| `script-element` / `script-type` | `<script>` 사용/타입 |
| `meta-refresh` | `<meta http-equiv="refresh">` 제한 |
| `autocomplete-password` / `valid-autocomplete` | `autocomplete` 값 |
| `tel-non-breaking` | 전화번호 내 non-breaking 문자 |

## 시맨틱 · 모범 사례

| 규칙 | 잡는 것 |
| --- | --- |
| `prefer-button` | `<input type="button">` 대신 `<button>` |
| `prefer-native-element` | ARIA role 대신 네이티브 요소 (`role="button"` → `<button>`) |
| `prefer-tbody` | `<table>`에 `<tbody>` |
| `no-multiple-main` | `<main>` 중복 |
| `unique-landmark` | 동일 유형 랜드마크 구분 필요 |
| `text-content` | 텍스트가 있어야 하는 요소가 비어 있음 |
| `empty-heading` | 빈 제목 (`<h2></h2>`) |
| `empty-title` / `long-title` | 빈/과도하게 긴 `<title>` |
| `multiple-labeled-controls` | 하나의 `<label>`이 여러 컨트롤 참조 |

## 접근성 (WCAG · ARIA)

`recommended`에 포함된 접근성 규칙. html-validate를 고른 핵심 이유다.

| 규칙 | 잡는 것 |
| --- | --- |
| `wcag/h30` | 링크에 식별 가능한 텍스트/대체 텍스트 |
| `wcag/h32` | 폼에 submit 버튼 |
| `wcag/h36` | 이미지 제출 버튼의 `alt` |
| `wcag/h37` | `<img>`의 `alt` 필수 |
| `wcag/h63` | 표 헤더 셀의 `scope` |
| `wcag/h67` | 장식용 이미지는 `alt=""` (그리고 `title` 없음) |
| `wcag/h71` | `<fieldset>`/`<legend>` 그룹화 |
| `area-alt` | `<area>`의 접근 가능한 텍스트 |
| `aria-hidden-body` | `<body>`에 `aria-hidden` 금지 |
| `aria-label-misuse` | 명명 불가 요소에 `aria-label` |
| `no-abstract-role` | 추상 ARIA role 사용 |
| `no-redundant-role` | 네이티브 의미와 중복되는 role |
| `no-redundant-aria-label` | 중복 `aria-label` |
| `no-redundant-for` / `valid-for` | `<label for>` 연결 문제 |
| `hidden-focusable` | 숨겨졌지만 포커스 가능한 요소 |
| `no-autoplay` | `<audio>`/`<video>` 자동재생 |
| `svg-focusable` | (recommended에서 **off**) |
| `no-unused-disable` | 실제로 아무것도 끄지 않는 비활성화 지시어 |

## 특정 규칙만 예외 처리하기

번들 설정은 `root: true`라 프로젝트 `.htmlvalidate.json`으로는 덮어쓸 수 없다. 대신 **HTML 주석 지시어**로 파일 안에서 국소적으로 끌 수 있다 (markdown의 `<!-- markdownlint-disable -->`와 같은 개념).

```html
<!-- 다음 한 요소에서만 wcag/h37 끔 -->
<!-- [html-validate-disable-next wcag/h37 -- 장식용 이미지] -->
<img src="deco.png">

<!-- 여는 지시어부터 블록 끝까지 끔 -->
<!-- [html-validate-disable-block no-inline-style] -->
<div style="color:red">...</div>

<!-- 파일 전체에서 끔 -->
<!-- [html-validate-disable no-inline-style] -->
```

`--` 뒤의 텍스트는 사유(주석)이며 선택 사항이다. 지시어 이름은 `disable-next`(다음 요소), `disable-block`(블록), `disable`(이후 전체)이며 `disable-next-line` 같은 이름은 없다. 남용을 막기 위해 `no-unused-disable`이 "실제로 아무것도 끄지 않은" 지시어를 다시 오류로 잡는다.

## 참고

- 규칙 목록·설명: <https://html-validate.org/rules/>
- 프리셋(`recommended`/`standard`/`a11y` 등): <https://html-validate.org/rules/presets.html>
- 인라인 주석 지시어: <https://html-validate.org/usage/#inline-configuration>
