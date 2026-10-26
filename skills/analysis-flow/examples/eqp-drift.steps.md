# eqp-drift 단계 표

FDC 설비 EQP01 의 센서 이탈 분석. 기간은 2026-10-20 00:00 ~ 2026-10-27 00:00.
`analysis-flow` 의 2단계가 만드는 중간물이다. 그림은 `eqp-drift.flow.json`,
부록은 이 표에서 나온다.

| 번호 | 이름 | 출처 | 쿼리 또는 명령 | 조건 | 얻은 것 | 다음 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 센서 목록 | DB 표: fdc_sensor | `SELECT sensor_id, sensor_name, unit FROM fdc_sensor WHERE eqp_id = 'EQP01' AND active = 1;` | 설비 EQP01 · 쓰는 센서만 | 센서 12개 | 2 |
| 2 | 센서 통계 조회 | DB 표: reading_stats | `SELECT sensor_id, ts, mean_val, ucl, lcl`<br>`FROM reading_stats`<br>`WHERE eqp_id = 'EQP01'`<br>`AND ts >= '2026-10-20' AND ts < '2026-10-27'`<br>`ORDER BY sensor_id, ts;` | 1번의 센서 · 기간 7일 | 시간별 통계 2,016행 | 3 |
| 3 | 수집 오류 확인 | 서버 로그 파일: /var/log/fdc/collector.log | `rg -n 'EQP01.*(ERROR\|timeout)' /var/log/fdc/collector.log` | 2번에서 이탈한 시각 앞뒤 10분 | 오류 0건 | 4 |
| 4 | 이탈 건수 · 평균 비교 | 앞 단계 결과: 2번 표 · 3번 로그 | `mean_val > ucl 또는 mean_val < lcl 인 행 수,`<br>`센서별 평균을 지난주 평균과 비교` | 수집 오류 시각은 뺀다 | 이탈 9건 · 평균 +4.2% | 5 |
| 5 | 이탈 많은가 | 사람 판단: 4번의 이탈 건수 | `이탈 > 5` | — | 예 | 이탈 > 5 → 6 · 이탈 ≤ 5 → 7 |
| 6 | 셋업 이벤트 조회 | DB 표: fdc_setup_event | `SELECT event_id, ts, event_type, operator`<br>`FROM fdc_setup_event`<br>`WHERE eqp_id = 'EQP01'`<br>`AND ts >= '2026-10-20' AND ts < '2026-10-27';` | 같은 기간 | 셋업 변경 2건(10-23 PM 교체) | 7 |
| 7 | 결과 정리 | 앞 단계 결과: 4번 · 6번 | — | — | 10-23 PM 교체 뒤 센서 3개 평균 이동 | 끝 |
