# 수집기(collector) — 구현 시 주의사항

설계 문서(`agent-dashboard-collector-design.md`)의 코드를 실제로 구현할 때 밟기 쉬운 함정들. 설계가 아니라 **구현 디테일**이라 따로 둔다. 6개 영역을 서로 적대적으로 검증하면서 잡은 치명 버그와 수정이고, stage 7(집계 API, `agent-dashboard-analysis-design.md`) 검증에서 잡힌 것도 이어서 기록한다.

## 요약 표

| 영역 | 치명 버그 | 수정 |
| --- | --- | --- |
| 핸들러(ingest) | 413 스트리밍 `req.destroy()`→`onErr(undefined)` 크래시 | `e?.message ?? "aborted"` + 프로세스 가드 |
| 핸들러(ingest) | async throw가 동기 try/catch 우회 | 핸들러 전체 try/catch + `unhandledRejection` 가드 |
| 핸들러/스트림/저장 | DNS-rebind 위조 Host로 시크릿 탈취 | Host 허용목록 → 421 |
| 저장(쓰기) | 큐를 개수로만 제한 → 이벤트당 5MB라 수십 GB로 부풀어 OOM | 큐를 BYTE로 제한, drop-oldest |
| 저장(쓰기) | 큐 전체를 한 배치로 splice → 합친 문자열이 ~536MB 초과 RangeError/OOM | `BATCH_ROWS`(256)만 잘라서 |
| 저장(쓰기) | NOT NULL에 undefined 바인드 → 한 행이 256행 배치 통째 롤백 | 행 단위 try + 필수필드 `"unknown"` 기본값 |
| 저장(retention) | size-cap이 freelist 못 봐서 **데이터 92% 삭제**(20000→1530) | `usedBytes()`(freelist 제외) + 루프 내 `incremental_vacuum` |
| 저장(retention) | 아카이브를 한 번에 전부 SELECT→join → 거대 문자열/OOM | 페이지(LIMIT N) 단위로 잘라서 gzip 스트림 |
| 저장(retention) | `runRetention` throw가 `setInterval`을 빠져나가 프로세스 사망 | 전체 try/catch |
| 런타임 | `EADDRINUSE`가 uncaughtException 가드에 삼켜져 "안 듣는 좀비" | `server.on('error')` 명시 처리 |
| 스트림 | ring이 개수만 제한 → 1000×5MB = 5GB RSS | BYTE 제한 + 이벤트당 크기 cap |
| 스트림 | `Last-Event-ID`가 재시작 시 0 리셋 → 옛 커서 재연결 클라가 아무것도 못 받음 | 부팅 시 `MAX(seq)` 시드 + 커서 클램프 |
| 보안 | redaction 키 매칭이 끝-앵커 + 중첩 skip → `secret_value`/`password_hash` 등 누출 | 키 어디든 매칭 + 하위 트리 통째 가림 |
| 런타임 | `status`가 토큰 stdout 유출 / `stop`이 재사용 PID kill | 토큰 비표시 + `/health` 신원확인 후 kill |
| 집계(stage 7) | node:sqlite가 number 파라미터를 REAL로 바인딩 → `received_at / ?`가 실수 나눗셈 → 시간 버킷이 행마다 갈라짐 | 버킷 크기(2값 화이트리스트 상수)를 SQL 리터럴로 인라인 |

## 영역별 메모

### 쓰기 경로 (3종)

1. **큐를 개수로만 제한 → 메모리 무한 증가.** 이벤트 하나가 최대 5MB(MAX_BODY)라, "최대 1만 개"식 개수 제한이면 수십 GB까지 부푼다. writer가 못 따라가면 OOM → 서버가 박스를 죽인다. → `Q_MAX_BYTES`로 총 바이트 제한 + drop-oldest.
2. **큐 전체를 한 배치로 → 거대 문자열 RangeError/OOM.** `q.splice(0, q.length)`로 밀린 것 전부를 한 번에 합쳐 쓰면, 합친 문자열이 Node 최대 문자열(~536MB)을 넘겨 RangeError로 터지거나 메모리 폭발. → `q.splice(0, BATCH_ROWS)`로 256행만, 나머지는 루프.
3. **독성 행 1개가 256행 배치 롤백(batch poisoning).** 배치를 `BEGIN IMMEDIATE … COMMIT` 하나로 묶었는데 한 행이 throw하면(NOT NULL에 undefined 등) ROLLBACK → 멀쩡한 255개까지 사라짐. → 행 단위 try로 나쁜 1개만 건너뛴다(+ `ON CONFLICT DO NOTHING`).

### retention

- **size-cap이 데이터를 92% 지운 버그.** `page_count`는 DELETE만으론 안 줄고(freelist로 갈 뿐) `incremental_vacuum` 후에야 준다. 그걸 모르고 `while (file_size > cap)`을 돌리면 조건이 영영 안 풀려 guard=50까지 돌며 5% 슬라이스를 50번 지운다(실측 20000→1530행). → `usedBytes() = (page_count - freelist_count) × page_size`로 재고, 루프 안에서 `incremental_vacuum`.
- **아카이브 OOM.** 삭제 대상 전부를 한 번에 SELECT→join하면 거대 문자열/메모리 폭발. → 페이지 단위로 잘라 gzip 스트림에 append.
- **retention throw가 프로세스를 죽임.** `setInterval(runRetention)`에서 throw가 콜백을 빠져나가면 프로세스 사망. → `runRetention` 전체를 try/catch.

### POST /events 핸들러 (`agent-dashboard-ingest-handler.mjs`에 반영)

- **413 스트리밍 경로 크래시.** 본문이 cap을 넘어 `req.destroy()`하면 `'aborted'` 이벤트가 인자 없이 동기 emit → `onErr(undefined)`에서 `e.message`가 throw → uncaughtException로 프로세스 사망. → `e?.message ?? "aborted"`로 null-safe + 프로세스 레벨 가드.
- **async throw가 라우터 try/catch 우회.** 라우터의 동기 try/catch는 첫 `await` 이후의 throw를 못 잡는다 → 핸들러 본문 전체를 try/catch로 + `unhandledRejection`/`uncaughtException` 가드.
- **413에서 소켓 destroy → ECONNRESET.** 응답을 먼저 보내고(`Connection: close`) 닫는다.

### SSE

- **ring이 개수만 제한 → 5GB RSS.** 슬롯 1000개에 각 5MB면 메모리가 5GB. → BYTE 예산 + 이벤트당 크기 cap(payload 잘라서 표시, 전체는 DB).
- **`Last-Event-ID` 재시작 시 0 리셋.** 프로세스 카운터를 0부터 다시 세면, 옛 커서로 재연결한 클라가 카운터가 따라잡을 때까지 아무것도 못 받는다. → 부팅 시 `MAX(seq)` 시드 + 커서를 현재 seq로 클램프.

### 보안 / 런타임

- **redaction 키 매칭 누출.** 키 정규식이 끝-앵커(`$`)면 `secret_value`/`password_hash`/`access_key_id`/`authorization` 같은 키를 놓치고, 매칭 시 primitive만 가리면 중첩 객체/배열 속 평문 시크릿이 샌다. → 키 어디에 있든 매칭 + 걸리면 하위 트리 통째 가림.
- **EADDRINUSE 좀비.** `server.on('error')` 없이 두면 바인드 실패가 uncaughtException 가드에 삼켜져, 프로세스는 살아있지만 안 듣는 좀비가 된다. → `server.on('error')`에서 EADDRINUSE를 명시 처리(우리 거면 exit 0, 남이면 exit 3).
- **`status` 토큰 유출 / `stop` 오살.** `status`가 pidfile을 통째로 출력하면 토큰이 화면에 샌다(→ 토큰은 출력 안 함). `stop`이 pidfile의 pid로 곧장 SIGTERM하면 PID 재사용으로 엉뚱한 프로세스를 죽일 수 있다(→ `/health`로 우리 서버 확인 후 kill).

### 집계 API (stage 7)

- **파라미터 바인딩이 정수 나눗셈을 깨는 함정.** node:sqlite(`DatabaseSync`)는 JS number를 정수여도 REAL로 바인딩한다. `(received_at / ?) * ?`는 실수 나눗셈이 되어 원값이 그대로 돌아오고, GROUP BY가 행마다 갈라져 "버킷팅이 조용히 안 되는" 버그가 된다. 버킷 합계는 전체 개수와 일치해서 합계 단언만으로는 못 잡는다 — **정렬 단언(`t % bucket_ms === 0`)이 필요**하다. → 값이 화이트리스트 상수일 때만 SQL 리터럴로 인라인(자유 입력은 절대 인라인 금지).
