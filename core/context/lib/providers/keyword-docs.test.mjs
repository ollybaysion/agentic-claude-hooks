#!/usr/bin/env node
// Integration tests for the keyword-docs engine's B모드 (params.hub) support.
// Run:
//   node core/context/lib/providers/keyword-docs.test.mjs
// No framework — exit 1 on the first failure. Direct calls (`layers` absent),
// same convention the engine itself documents: merged params act as the
// project layer, and the hub target falls back to sources[0].
// hub-cache.mjs's own unit tests (../hub-cache.test.mjs) cover the fetch
// primitives in isolation; these tests cover the WIRING — that keyword-docs
// actually calls them at the right points and behaves identically to before
// when `params.hub` is absent (regression safety).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeKeywordDocsProvider } from "./keyword-docs.mjs";

let failed = 0;
function check(name, ok, detail = "") {
  const tag = ok ? "ok  " : "FAIL";
  console.log(`${tag} ${name}${ok ? "" : "  → " + detail}`);
  if (!ok) failed++;
}

async function checkThrowsNever(name, fn) {
  try {
    await fn();
  } catch (err) {
    check(name, false, `threw: ${err?.message ?? err}`);
  }
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), "keyword-docs-hub-test-"));
}

function res(status, { body = "", etag } = {}) {
  return {
    status,
    headers: { get: (k) => (k.toLowerCase() === "etag" ? (etag ?? null) : null) },
    text: async () => body,
  };
}

// A tiny in-memory akg server: serves the index at /api/index/:type and the
// doc at /api/docs/:type/:id?format=md, ETag-aware (304 on a matching
// If-None-Match), and counts calls per endpoint.
function fakeHubServer({ indexBody, docBody, indexEtag = "idx-1", docEtag = "doc-1" }) {
  const calls = { index: 0, doc: 0 };
  const fetchImpl = async (url, opts) => {
    const inm = opts.headers["if-none-match"];
    if (url.includes("/api/index/")) {
      calls.index++;
      if (inm === indexEtag) return res(304);
      return res(200, { body: indexBody, etag: indexEtag });
    }
    if (url.includes("/api/docs/")) {
      calls.doc++;
      if (inm === docEtag) return res(304);
      return res(200, { body: docBody, etag: docEtag });
    }
    return res(404);
  };
  return { calls, fetchImpl };
}

// ---------------------------------------------------------------- no hub (regression)

await checkThrowsNever("no hub param -> unchanged local-only injection, index/doc untouched", async () => {
  const dir = freshDir();
  const indexPath = join(dir, "index.json");
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "t.sensor.md"), "# sensor doc local");
  writeFileSync(indexPath, JSON.stringify([{ keywords: ["sensor"], path: "docs/t.sensor.md" }]));

  const provider = makeKeywordDocsProvider({ id: "test-no-hub" });
  const result = await provider.run({
    cwd: dir,
    prompt: "tell me about the sensor",
    sessionId: "s1",
    params: { index: indexPath, dedup: false },
  });
  check("no hub -> injects local doc as before", result?.text?.includes("# sensor doc local"), JSON.stringify(result));
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fresh fetch fills an empty mirror

await checkThrowsNever("hub: first match with an empty mirror -> index + doc fetched and written to disk", async () => {
  const dir = freshDir(); // nothing on disk yet — first-ever B모드 access, no prior `akg sync`
  const indexPath = join(dir, "index.json");
  const indexBody = JSON.stringify([{ keywords: ["sensor"], path: "docs/t.sensor.md" }]);
  const server = fakeHubServer({ indexBody, docBody: "# fresh from hub" });

  const provider = makeKeywordDocsProvider({ id: "test-hub-fill" });
  const result = await provider.run({
    cwd: dir,
    prompt: "tell me about the sensor",
    sessionId: "s1",
    params: { index: indexPath, dedup: false, hub: { url: "http://fake", type: "db-schema", fetchImpl: server.fetchImpl } },
  });

  check("index fetched exactly once", server.calls.index === 1, `calls=${JSON.stringify(server.calls)}`);
  check("doc fetched exactly once", server.calls.doc === 1, `calls=${JSON.stringify(server.calls)}`);
  check("index.json created on disk from the fetch", existsSync(indexPath) && readFileSync(indexPath, "utf8") === indexBody);
  check(
    "doc file created on disk from the fetch",
    existsSync(join(dir, "docs", "t.sensor.md")) && readFileSync(join(dir, "docs", "t.sensor.md"), "utf8") === "# fresh from hub",
  );
  check("injected text carries the freshly fetched body", result?.text?.includes("# fresh from hub"), JSON.stringify(result));
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fail-open

await checkThrowsNever("hub: server down but mirror already populated -> fail-open to existing content", async () => {
  const dir = freshDir();
  const indexPath = join(dir, "index.json");
  const indexBody = JSON.stringify([{ keywords: ["sensor"], path: "docs/t.sensor.md" }]);
  mkdirSync(join(dir, "docs"), { recursive: true });
  writeFileSync(join(dir, "docs", "t.sensor.md"), "# stale local copy");
  writeFileSync(indexPath, indexBody);

  const provider = makeKeywordDocsProvider({ id: "test-hub-down" });
  const result = await provider.run({
    cwd: dir,
    prompt: "tell me about the sensor",
    sessionId: "s1",
    params: {
      index: indexPath,
      dedup: false,
      hub: { url: "http://fake", type: "db-schema", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } },
    },
  });
  check("fail-open still injects the stale local copy", result?.text?.includes("# stale local copy"), JSON.stringify(result));
  check("index.json content untouched by the failed refresh", readFileSync(indexPath, "utf8") === indexBody);
  rmSync(dir, { recursive: true, force: true });
});

await checkThrowsNever("hub: server down, no local copy at all -> silently skipped (no stray files, no throw)", async () => {
  const dir = freshDir(); // no index.json, no docs/ — nothing has ever synced here
  const indexPath = join(dir, "index.json");

  const provider = makeKeywordDocsProvider({ id: "test-hub-empty" });
  const result = await provider.run({
    cwd: dir,
    prompt: "tell me about the sensor",
    sessionId: "s1",
    params: {
      index: indexPath,
      dedup: false,
      hub: { url: "http://fake", type: "db-schema", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } },
    },
  });
  check("no index ever materializes -> nothing to match -> null (not an error)", result === null, JSON.stringify(result));
  check("refresh failure never creates a stray index.json", !existsSync(indexPath));
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- pointer precision

await checkThrowsNever("hub: pointer-precision match on an empty mirror -> fetch fills the cache, pointer line injected", async () => {
  const dir = freshDir();
  const indexPath = join(dir, "index.json");
  const indexBody = JSON.stringify([{ keywords: ["sensor"], path: "docs/t.sensor.md", precision: 0.5 }]);
  const server = fakeHubServer({ indexBody, docBody: "# pointer target body" });

  const provider = makeKeywordDocsProvider({ id: "test-hub-pointer" });
  const result = await provider.run({
    cwd: dir,
    prompt: "tell me about the sensor",
    sessionId: "s1",
    params: { index: indexPath, dedup: false, hub: { url: "http://fake", type: "db-schema", fetchImpl: server.fetchImpl } },
  });

  check("pointer line injected (not the full body)", result?.text?.startsWith("→ ") && result.text.includes("related doc"), JSON.stringify(result));
  check("pointed-at file was fetched onto disk despite being a pointer match", existsSync(join(dir, "docs", "t.sensor.md")));
  check("doc body itself is not inlined in a pointer injection", !result.text.includes("# pointer target body"));
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- TTL (index) vs ETag (doc) across turns

await checkThrowsNever("hub: index refresh is TTL-gated across turns, doc is re-checked every match via ETag", async () => {
  const dir = freshDir();
  const indexPath = join(dir, "index.json");
  const indexBody = JSON.stringify([{ keywords: ["sensor"], path: "docs/t.sensor.md" }]);
  const server = fakeHubServer({ indexBody, docBody: "# v1" });
  const params = {
    index: indexPath,
    dedup: false,
    hub: { url: "http://fake", type: "db-schema", fetchImpl: server.fetchImpl },
  };
  const provider = makeKeywordDocsProvider({ id: "test-hub-ttl" });

  const first = await provider.run({ cwd: dir, prompt: "sensor", sessionId: "s1", params });
  const second = await provider.run({ cwd: dir, prompt: "sensor", sessionId: "s1", params });

  check("index fetched only once across two turns (within the default 5m TTL)", server.calls.index === 1, `calls=${JSON.stringify(server.calls)}`);
  check("doc endpoint hit on every match (ETag-based freshness, not TTL-based)", server.calls.doc === 2, `calls=${JSON.stringify(server.calls)}`);
  check("first turn injects the doc", first?.text?.includes("# v1"));
  check("second turn still injects the doc (304 -> cached copy reused)", second?.text?.includes("# v1"));
  rmSync(dir, { recursive: true, force: true });
});

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall keyword-docs hub-wiring checks passed");
