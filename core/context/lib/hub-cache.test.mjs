#!/usr/bin/env node
// Unit tests for core/context/lib/hub-cache.mjs (B모드). Run:
//   node core/context/lib/hub-cache.test.mjs
// No framework — exit 1 on the first failure so it can gate a commit. Every
// scenario below is about ONE contract: a down/slow/wrong server must never
// corrupt or block past what's already on disk (fail-open), while a healthy
// one keeps the local cache fresh cheaply (TTL + ETag).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchDocFresh,
  loadCacheState,
  refreshIndexIfStale,
  resolveHubToken,
  saveCacheState,
} from "./hub-cache.mjs";

let failed = 0;
function check(name, ok, detail = "") {
  const tag = ok ? "ok  " : "FAIL";
  console.log(`${tag} ${name}${ok ? "" : "  → " + detail}`);
  if (!ok) failed++;
}

async function checkThrowsNever(name, fn) {
  try {
    await fn();
    check(name, true);
  } catch (err) {
    check(name, false, `threw: ${err?.message ?? err}`);
  }
}

function freshDir() {
  return mkdtempSync(join(tmpdir(), "hub-cache-test-"));
}

// duck-typed Fetch API Response
function res(status, { body = "", etag } = {}) {
  return {
    status,
    headers: { get: (k) => (k.toLowerCase() === "etag" ? (etag ?? null) : null) },
    text: async () => body,
  };
}

// ---------------------------------------------------------------- resolveHubToken

{
  const explicit = resolveHubToken({ token: "explicit-tok" });
  check("resolveHubToken: explicit hub.token wins", explicit === "explicit-tok", explicit);
}
{
  const prevEnv = process.env.AKG_TOKEN;
  process.env.AKG_TOKEN = "env-tok";
  const fromEnv = resolveHubToken({});
  check("resolveHubToken: AKG_TOKEN env used when no explicit token", fromEnv === "env-tok", fromEnv);
  if (prevEnv === undefined) delete process.env.AKG_TOKEN;
  else process.env.AKG_TOKEN = prevEnv;
}
{
  const prevEnv = process.env.AKG_TOKEN;
  delete process.env.AKG_TOKEN;
  const none = resolveHubToken({});
  // No ~/.claude/akg/token assumed present in a clean test env; either null or
  // a real value is "correct" depending on the host, so only assert no throw.
  check("resolveHubToken: absent everywhere resolves without throwing", none === null || typeof none === "string");
  if (prevEnv !== undefined) process.env.AKG_TOKEN = prevEnv;
}

// ---------------------------------------------------------------- cache state I/O

{
  const dir = freshDir();
  const indexPath = join(dir, "index.json");
  const loaded = loadCacheState(indexPath);
  check("loadCacheState: missing file -> clean state", loaded.index === null && Object.keys(loaded.docs).length === 0, JSON.stringify(loaded));

  saveCacheState(indexPath, { index: { etag: "e1", fetchedAt: 123 }, docs: { "docs/a.md": { etag: "e2", fetchedAt: 456 } } });
  const reloaded = loadCacheState(indexPath);
  check("saveCacheState round-trips", reloaded.index.etag === "e1" && reloaded.docs["docs/a.md"].etag === "e2", JSON.stringify(reloaded));
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- refreshIndexIfStale

await checkThrowsNever("refreshIndexIfStale: fresh cache -> fetchImpl not called", async () => {
  const dir = freshDir();
  const indexPath = join(dir, "index.json");
  writeFileSync(indexPath, "[]");
  let called = false;
  const cacheState = { index: { etag: "e1", fetchedAt: 1000 }, docs: {} };
  await refreshIndexIfStale({
    indexPath,
    hub: { url: "http://fake", type: "db-schema", indexTtlMs: 60000 },
    cacheState,
    now: 1000 + 5000, // well within the 60s TTL
    fetchImpl: async () => { called = true; return res(200, { body: "[]" }); },
  });
  assert.equal(called, false, "fetchImpl must not be called while cache is fresh");
  rmSync(dir, { recursive: true, force: true });
});

await checkThrowsNever("refreshIndexIfStale: stale + 200 -> writes index + updates cache", async () => {
  const dir = freshDir();
  const indexPath = join(dir, "index.json");
  writeFileSync(indexPath, "[]"); // old content
  const cacheState = { index: null, docs: {} };
  const fresh = JSON.stringify([{ keywords: ["x"], path: "docs/x.md" }]);
  await refreshIndexIfStale({
    indexPath,
    hub: { url: "http://fake", type: "db-schema" },
    cacheState,
    now: 9999,
    fetchImpl: async () => res(200, { body: fresh, etag: "rev-1" }),
  });
  assert.equal(readFileSync(indexPath, "utf8"), fresh, "index.json content");
  assert.equal(cacheState.index.etag, "rev-1", "etag recorded");
  assert.equal(cacheState.index.fetchedAt, 9999, "fetchedAt recorded");
  rmSync(dir, { recursive: true, force: true });
});

await checkThrowsNever("refreshIndexIfStale: 304 -> index.json untouched, fetchedAt bumped", async () => {
  const dir = freshDir();
  const indexPath = join(dir, "index.json");
  const original = "[ORIGINAL]"; // deliberately not valid JSON — proves it's never re-parsed/rewritten
  writeFileSync(indexPath, original);
  const cacheState = { index: { etag: "rev-1", fetchedAt: 0 }, docs: {} };
  await refreshIndexIfStale({
    indexPath,
    hub: { url: "http://fake", type: "db-schema", indexTtlMs: 10 }, // now(42) - fetchedAt(0) must exceed this
    cacheState,
    now: 42,
    fetchImpl: async (url, opts) => {
      assert.equal(opts.headers["if-none-match"], "rev-1", "sends cached etag");
      return res(304);
    },
  });
  assert.equal(readFileSync(indexPath, "utf8"), original, "304 must not touch the file");
  assert.equal(cacheState.index.etag, "rev-1", "etag retained");
  assert.equal(cacheState.index.fetchedAt, 42, "fetchedAt bumped so a healthy server isn't repolled every turn");
  rmSync(dir, { recursive: true, force: true });
});

await checkThrowsNever("refreshIndexIfStale: fetchImpl throws -> cache + file untouched", async () => {
  const dir = freshDir();
  const indexPath = join(dir, "index.json");
  const original = "[STILL-HERE]";
  writeFileSync(indexPath, original);
  const cacheState = { index: { etag: "old", fetchedAt: 0 }, docs: {} };
  let called = false;
  await refreshIndexIfStale({
    indexPath,
    hub: { url: "http://fake", type: "db-schema", indexTtlMs: 10 }, // force staleness so fetchImpl actually runs
    cacheState,
    now: 500,
    fetchImpl: async () => { called = true; throw new Error("ECONNREFUSED"); },
  });
  assert.equal(called, true, "test setup sanity: fetchImpl must actually run for this scenario");
  assert.equal(readFileSync(indexPath, "utf8"), original);
  assert.deepEqual(cacheState.index, { etag: "old", fetchedAt: 0 }, "fetchedAt NOT bumped -> next turn retries immediately");
  rmSync(dir, { recursive: true, force: true });
});

await checkThrowsNever("refreshIndexIfStale: non-JSON 200 body -> cache + file untouched", async () => {
  const dir = freshDir();
  const indexPath = join(dir, "index.json");
  const original = "[STILL-HERE]";
  writeFileSync(indexPath, original);
  const cacheState = { index: null, docs: {} };
  await refreshIndexIfStale({
    indexPath,
    hub: { url: "http://fake", type: "db-schema" },
    cacheState,
    now: 1,
    fetchImpl: async () => res(200, { body: "<html>not json</html>" }),
  });
  assert.equal(readFileSync(indexPath, "utf8"), original);
  assert.equal(cacheState.index, null);
  rmSync(dir, { recursive: true, force: true });
});

await checkThrowsNever("refreshIndexIfStale: abort fires at timeoutMs, never hangs", async () => {
  const dir = freshDir();
  const indexPath = join(dir, "index.json");
  writeFileSync(indexPath, "[]");
  const cacheState = { index: null, docs: {} };
  const started = Date.now();
  await refreshIndexIfStale({
    indexPath,
    hub: { url: "http://fake", type: "db-schema", timeoutMs: 30 },
    cacheState,
    now: 1,
    fetchImpl: (url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  const elapsed = Date.now() - started;
  check("refreshIndexIfStale: bounded by timeoutMs (not left hanging)", elapsed < 2000, `elapsed=${elapsed}ms`);
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fetchDocFresh

await checkThrowsNever("fetchDocFresh: 200 -> writes body, records etag, creates parent dirs", async () => {
  const dir = freshDir();
  const abs = join(dir, "nested", "docs", "t.sensor.md");
  const cacheState = { index: null, docs: {} };
  const ok = await fetchDocFresh({
    abs,
    relPath: "docs/t.sensor.md",
    hub: { url: "http://fake", type: "db-schema" },
    cacheState,
    fetchImpl: async (url) => {
      assert.ok(url.endsWith("/api/docs/db-schema/t.sensor?format=md"), url);
      return res(200, { body: "# sensor doc", etag: "doc-rev-1" });
    },
  });
  check("fetchDocFresh 200 -> ok true", ok === true);
  check("fetchDocFresh 200 -> file written", existsSync(abs) && readFileSync(abs, "utf8") === "# sensor doc");
  check("fetchDocFresh 200 -> etag cached", cacheState.docs["docs/t.sensor.md"].etag === "doc-rev-1");
  rmSync(dir, { recursive: true, force: true });
});

await checkThrowsNever("fetchDocFresh: cached etag sent as If-None-Match, 304 keeps local file", async () => {
  const dir = freshDir();
  const abs = join(dir, "t.sensor.md");
  writeFileSync(abs, "# already cached");
  const cacheState = { index: null, docs: { "docs/t.sensor.md": { etag: "doc-rev-1", fetchedAt: 0 } } };
  const ok = await fetchDocFresh({
    abs,
    relPath: "docs/t.sensor.md",
    hub: { url: "http://fake", type: "db-schema" },
    cacheState,
    fetchImpl: async (url, opts) => {
      assert.equal(opts.headers["if-none-match"], "doc-rev-1");
      return res(304);
    },
  });
  check("fetchDocFresh 304 -> ok true", ok === true);
  check("fetchDocFresh 304 -> local file unchanged", readFileSync(abs, "utf8") === "# already cached");
  rmSync(dir, { recursive: true, force: true });
});

await checkThrowsNever("fetchDocFresh: server unreachable, local copy exists -> fail-open to cache", async () => {
  const dir = freshDir();
  const abs = join(dir, "t.sensor.md");
  writeFileSync(abs, "# stale but present");
  const cacheState = { index: null, docs: {} };
  const ok = await fetchDocFresh({
    abs,
    relPath: "docs/t.sensor.md",
    hub: { url: "http://fake", type: "db-schema" },
    cacheState,
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  check("fetchDocFresh down-server + cache -> ok true (fallback)", ok === true);
  check("fetchDocFresh down-server -> file content untouched", readFileSync(abs, "utf8") === "# stale but present");
  rmSync(dir, { recursive: true, force: true });
});

await checkThrowsNever("fetchDocFresh: server unreachable, no local copy -> ok false (silent skip)", async () => {
  const dir = freshDir();
  const abs = join(dir, "t.sensor.md"); // never created
  const cacheState = { index: null, docs: {} };
  const ok = await fetchDocFresh({
    abs,
    relPath: "docs/t.sensor.md",
    hub: { url: "http://fake", type: "db-schema" },
    cacheState,
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  check("fetchDocFresh down-server + no cache -> ok false", ok === false);
  check("fetchDocFresh down-server + no cache -> no file created", !existsSync(abs));
  rmSync(dir, { recursive: true, force: true });
});

if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
console.log("\nall hub-cache checks passed");
