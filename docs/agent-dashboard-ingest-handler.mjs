// agent-dashboard-ingest-handler.mjs
// 수집기(collector)의 POST /events 핫패스 참조 구현 — 설계 문서에서 분리한 발췌본.
// (agent-dashboard-collector-design.md §4 참고)
//
// 이 코드는 server.mjs에 합쳐 넣는 조각이다. 아래 심볼은 server.mjs의 다른 부분에
// 정의돼 있다고 가정한다:
//   json(res, status, obj, extraHeaders)  — JSON 응답 헬퍼
//   hostOk(req) / authed(req)             — Host 허용목록 / bearer 검사 (설계 §8)
//   normalize(env, received_at)           — 봉투 정규화 (관대 처리)
//   dedupHit(key)                         — 인메모리 TTL dedup 게이트
//   SEQ                                   — 전역 단조 카운터 (부팅 시 MAX(seq)+1로 시드)
//   REDACT                                — redaction on/off (env OBS_REDACT)
//   redactDeep(payload)                   — redaction (설계 §8)
//   enqueueWrite(rec) / broadcast(rec)    — 저장소(§5) / SSE(§6)
//   logSafe(tag, err)                     — 시크릿이 새지 않는 운영 로그 (§7)
//   MAX_BODY / BODY_TIMEOUT_MS            — 본문 크기 상한 / 느린 본문 타임아웃
//
// 검증 단계에서 잡은 치명 버그 셋이 반영돼 있다 (설계 문서 부록 B):
//   ① 413 스트리밍 경로의 req.destroy() → onErr(undefined) 크래시
//   ② async 핸들러 throw가 라우터의 동기 try/catch를 우회
//   ③ 413에서 소켓을 destroy해 ECONNRESET

const KNOWN_EVENTS = new Set(["PreToolUse","PostToolUse","UserPromptSubmit","Notification",
  "Stop","SubagentStop","PreCompact","SessionStart","SessionEnd"]);
const PROMOTED = ["tool_name","tool_use_id","error","agent_id","agent_type","source","reason"];

class BodyError extends Error { constructor(code,status,msg){ super(msg); this.code=code; this.status=status; } }

function readBody(req, cap = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > cap)
      return reject(new BodyError("TOO_LARGE", 413, `declared ${declared} > ${cap}`));
    const chunks = []; let size = 0, settled = false;
    const done = (fn,a) => { if (settled) return; settled = true; cleanup(); fn(a); };
    const timer = setTimeout(() => done(reject, new BodyError("TIMEOUT",408,"slow body")), BODY_TIMEOUT_MS);
    const onData = (c) => {
      size += c.length;
      if (size > cap) return done(reject, new BodyError("TOO_LARGE",413,`streamed > ${cap}`));
      chunks.push(c);
    };
    const onEnd = () => done(resolve, Buffer.concat(chunks, size));
    // ★버그수정(CRITICAL): req.destroy()가 'aborted'를 인자 없이 동기 emit → onErr(undefined).
    //   e.message 접근이 throw → uncaughtException → 프로세스 사망. e?.message 로 null-safe.
    const onErr = (e) => done(reject, new BodyError("ABORTED",400, e?.message ?? "aborted"));
    function cleanup(){ clearTimeout(timer); req.off("data",onData); req.off("end",onEnd);
      req.off("error",onErr); req.off("aborted",onErr); }
    req.on("data",onData); req.on("end",onEnd); req.on("error",onErr); req.on("aborted",onErr);
  });
}

async function handleEvents(req, res) {
  try {
    if (!hostOk(req))  return json(res, 421, { error: "bad host" });   // anti DNS-rebind
    if (!authed(req))  return json(res, 401, { error: "unauthorized" });
    let raw;
    try { raw = await readBody(req); }
    catch (e) {
      // ★413은 소켓을 destroy하지 말고 응답을 먼저 보낸다(Connection: close).
      if (e.code === "TOO_LARGE") return json(res, 413, { error: "too large", cap: MAX_BODY }, { Connection: "close" });
      if (e.code === "TIMEOUT")   return json(res, 408, { error: "timeout" }, { Connection: "close" });
      return json(res, 400, { error: "bad body", detail: e.message });
    }
    const received_at = Date.now();
    let env; try { env = JSON.parse(raw.toString("utf8")); }
    catch { return json(res, 400, { error: "malformed json" }); }

    const { rec, error } = normalize(env, received_at);   // 관대: hook_event_type 문자열만 필수
    if (error) return json(res, 400, { error });

    const key = rec.tool_use_id ? `${rec.tool_use_id}|${rec.hook_event_type}` : null;
    if (dedupHit(key)) return json(res, 200, { status: "duplicate" });

    rec.seq = String(++SEQ);                                // 유일 식별자
    json(res, 202, { status: "accepted", seq: rec.seq, id: rec.id }, { "X-Obs-Seq": rec.seq });

    // ── post-ack 단일 단계: 응답 끝난 뒤. redact ONCE → writer + broadcaster 양쪽에 같은 것.
    setImmediate(() => { try { ingestPostAck(rec); } catch (e) { logSafe("post-ack", e); } });
  } catch (e) {
    // ★async throw가 라우터 동기 try/catch를 우회 → 여기서 잡는다.
    if (!res.headersSent) try { json(res, 500, { error: "internal" }); } catch {}
    logSafe("handleEvents", e);
  }
}

function ingestPostAck(rec) {
  const safe = REDACT ? { ...rec, payload: redactDeep(rec.payload).value } : rec;
  enqueueWrite(safe);     // §5 저장소 (byte-bounded 큐, 자가복구 consumer)
  broadcast(safe);        // §6 SSE (byte-bounded ring)
}

export { readBody, handleEvents, ingestPostAck, BodyError, KNOWN_EVENTS, PROMOTED };
