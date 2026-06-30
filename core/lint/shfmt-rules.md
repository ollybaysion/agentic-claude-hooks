# Shell 포맷 규칙 (shfmt)

우리 lint 훅은 `.sh`/`.bash` 파일에 대해 `shfmt -d <file>`를 실행해 포맷이 정규형과 일치하는지 검사한다. 여기서 중요한 점은 shfmt가 규칙 ID(예: `SC2086`)를 보고하는 린터가 아니라 `gofmt` 스타일의 셸 전용 *포매터*라는 것이다. 따라서 shfmt의 "규칙"은 항상 적용되는 정규 포맷, 설정 가능한 printer/parser 옵션, `-s` 단순화 변환, EditorConfig 연동으로 구성된다. 코드의 잠재적 버그(따옴표 누락, 잘못된 변수 확장 등)는 검사하지 않으므로 shellcheck와는 경쟁이 아니라 보완 관계이며, 같은 `.sh` 파일에 둘을 함께 적용하는 것이 이상적이다.

## shfmt가 항상 정규화하는 것 (기본 포맷)

다음은 별도 플래그 없이 항상 적용되는 정규 포맷이다 (기본값 기준, 즉 탭 들여쓰기).

- 들여쓰기는 탭을 사용하며 중첩 깊이마다 한 단계씩 늘어난다. 원본 들여쓰기는 버려지고 재계산된다 (`-i 0` 기본값).
- 연속된 공백/탭을 하나로 합치고 토큰 간격을 정규화한다. 예: `if   true;then` → `if true; then`, `echo  "a"` → `echo "a"`.
- `case` 분기의 `;;` 앞에 공백을 넣는다. 예: `1) echo one;;` → `1) echo one ;;` (분기 본문은 기본적으로 들여쓰지 않음).
- 리다이렉트는 기본적으로 대상에 붙인다. 예: `cat <file >out`는 그대로 유지된다.
- 줄 끝의 이항 연산자는 줄 끝에 남고 이어지는 줄은 들여쓴다. 예: `true &&` 다음 줄의 `false`는 탭으로 들여쓰진다.
- 함수 여는 중괄호는 같은 줄에 둔다. 예: `foo() {`.
- 빈 줄 3개 이상은 1개로 합치고, 블록의 시작/끝 빈 줄은 제거한다.
- 줄 끝 공백을 제거한다.
- 줄 끝 세미콜론을 제거한다. 예: `bar;` → `bar`. 배열 리터럴 내부 여백도 제거한다. 예: `arr=( a b c )` → `arr=(a b c)`.
- 인라인 주석은 코드와 `#` 사이에 공백 한 칸을 보장한다. 다만 인접한 인라인 주석들은 패딩을 넣어 열을 맞춘다 (아래 주의 참고). 주석 텍스트 자체는 변경하지 않는다.

주의: 인라인 주석 정렬은 제어 플래그가 없는 상시 동작이며 "공백을 하나로 합친다"는 규칙의 예외다. 서로 인접한 줄에 인라인 주석이 있으면 짧은 줄에 패딩이 추가되어 주석이 한 열로 정렬된다.

- `a=1 # one` / `bb=2 # two` → `a=1  # one` / `bb=2 # two` (짧은 줄이 패딩됨)
- `echo hi # c` / `x=1 #nospace` → `echo hi # c` / `x=1     #nospace`
- 주석을 가진 인접 줄이 없는 단독 인라인 주석은 패딩되지 않는다 (`x=1 #nospace`만 있으면 그대로 유지).

훅 영향: 개별 주석이 이미 공백 한 칸을 갖고 있어도, 인접 인라인 주석들이 열 정렬되지 않았다는 이유만으로 파일이 `shfmt -d`에서 실패할 수 있다.

## 옵션 (printer / parser)

| 플래그 | 의미 | 기본값 |
| --- | --- | --- |
| `-i, --indent uint` | 0이면 탭, N(>0)이면 N칸 공백 들여쓰기 | 0 (탭) |
| `-bn, --binary-next-line` | 이항 연산자(`&&`, `pipe` 등)가 다음 줄 시작에 올 수 있음 | off |
| `-ci, --case-indent` | `case` 분기를 한 단계 들여씀 | off |
| `-sr, --space-redirects` | 리다이렉트 연산자 뒤에 공백을 넣음 (`> out`) | off |
| `-kp, --keep-padding` | 열 정렬 패딩을 유지함 | off |
| `-fn, --func-next-line` | 함수 여는 중괄호를 별도 줄에 둠 | off |
| `-mn, --minify` | 코드를 최소화 (`-s` 포함) | off |
| `-ln, --language-dialect str` | `bash`/`posix`/`mksh`/`bats`/`zsh` 방언 지정 | `auto` |
| `-p, --posix` | `-ln=posix`의 단축형 | off |
| `-s, --simplify` | 코드 단순화 변환 적용 | off |

`-bn`은 이미 여러 줄에 걸친 연산자에만 영향을 주며 한 줄 표현식을 강제로 줄바꿈하지는 않는다. 켜면 출력은 `true \`(백슬래시) + 줄바꿈 + 탭 + `&& false` 형태가 된다.

`-kp`는 v3.13.1에서 정상 동작한다 (`a=1    b=2`가 유지됨, 없으면 `a=1 b=2`로 합쳐짐). 다만 상류 godoc에서는 deprecated로 표시되어 있으며 `--help`에는 그 표시가 없다.

`-mn` 검증 예: `foo() {` → `foo(){`, `true && false || true` → `true&&false||true`, 주석 제거, 들여쓰기/빈 줄 제거.

## -s 단순화(simplify) 규칙

v3.13.1에서 `-s`가 수행하는 정확한 변환 집합이다.

### `[[ ]]` 불필요한 따옴표 제거

LHS/단어 쪽의 불필요한 따옴표를 제거한다. `==`/`!=`/`=~`의 RHS 따옴표는 패턴/정규식 의미 때문에 유지한다.

```bash
# before
[[ "$x" == foo ]]
[[ -n "$x" && "$y" = z ]]
[[ "$a" == "$b" ]]
[[ "$a" =~ "re" ]]
```

```bash
# after
[[ $x == foo ]]
[[ -n $x && $y == z ]]
[[ $a == "$b" ]]
[[ $a =~ "re" ]]
```

### `[[ ]]` 의 `=` → `==` 정규화

이는 `-s` 전용이며 기본 출력은 `[[ $y = z ]]`를 그대로 둔다.

```bash
# before
[[ $y = z ]]
```

```bash
# after (only with -s)
[[ $y == z ]]
```

### 산술 괄호 정리

불필요한 산술 괄호를 제거하되 의미 있는 그룹화는 보존한다.

```bash
# before
a=$(( ( 1 + 2 ) ))
echo $(( (a) ))
x=$(( ((1)) + (2) ))
```

```bash
# after
a=$((1 + 2))
echo $((a))
x=$(((1) + (2)))
```

비기능(문서화하지 않을 것): `-s`는 `${a}`를 `$a`로 바꾸지 않으며(따옴표 유무 무관), 단일 대괄호 테스트 `[ ... ]`는 건드리지 않고, 배열 인덱스 안의 따옴표도 바꾸지 않는다. 공백 합치기, 줄 끝 세미콜론 제거, 배열 리터럴 여백 제거, 기본 리다이렉트 붙이기는 `-s`가 아니라 기본 포맷이다.

## EditorConfig 연동

shfmt는 이름이 지정된 파일 경로에 대해 `.editorconfig`를 자동으로 읽는다 (stdin 제외). 상위 디렉터리를 거슬러 올라가며 탐색하고 `root=true`를 존중하며, 동일 키에 대해 CLI 플래그가 우선한다.

| EditorConfig 키 | 대응 옵션 |
| --- | --- |
| `indent_style=tab` | `-i 0` |
| `indent_style=space` + `indent_size=N` | `-i N` |
| `switch_case_indent=true` | `-ci` |
| `binary_next_line=true` | `-bn` |
| `space_redirects=true` | `-sr` |
| `function_next_line=true` | `-fn` |
| `keep_padding=true` | `-kp` |
| `shell_variant=bash/posix/mksh/bats/zsh` | `-ln` |

EditorConfig 키가 없는 CLI 전용 옵션: `-s`, `-mn`, 그리고 `shell_variant`를 통하지 않는 `-p`.

## 우리 훅에서의 동작

우리 훅은 `.sh`/`.bash` 파일에 대해 `shfmt -d <file>`을 실행한다 (diff 모드).

- exit 0: 파일이 이미 정규 포맷에 맞음 (stdout 없음).
- nonzero (exit 1): 재포맷이 필요한 차이가 있거나 구문 오류가 있음.
  - 차이가 있으면 unified diff가 stdout으로 출력된다 (`--- f.orig` / `+++ f` 헤더 포함).
  - 구문 오류이면 진단 메시지가 stderr로 출력된다. 따라서 stdout(diff)과 stderr(진단)로 둘을 구분할 수 있다.

구문 오류 진단의 `(parsed as posix via EditorConfig)` 같은 괄호 문구는 구문에 따라 다르게 나타난다. 예를 들어 배열은 `arrays are a bash/mksh/zsh feature; tried parsing as posix (parsed as posix via EditorConfig)`처럼 표시되지만, 프로세스 치환 `<(...)` 같은 경우는 괄호 문구 없이 일반 메시지만 나온다. 참고로 `[[ ... ]]`는 shfmt의 posix 파서에서도 허용되므로 "bash 전용" 예시로는 적절하지 않다.

shfmt는 셸 코드의 버그를 잡지 않으므로 같은 `.sh` 파일에 shellcheck와 함께 적용해 정적 분석을 보완한다.

결정성 주의: `shfmt -d <file>`은 printer 플래그 없이 실행되므로 발견되는 `.editorconfig`에 따라 결과가 달라진다. EditorConfig와 무관하게 훅을 결정적으로 만들려면 printer 플래그(예: `-i`, `-ci`, `-bn`, `-sr`, `-fn` 및 원하는 `-ln`/`-p`)를 명시적으로 고정한다.

sudo 없이 shfmt를 설치하는 방법은 README를 참고한다.
