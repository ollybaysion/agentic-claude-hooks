// core/context/lib/hub-cache.mjs — B모드 (hub-fetch) support for keyword-docs.
//
// keyword-docs' local matching stays untouched (agent-knowledge-governance
// design §8.3): detection is always against the on-disk index.json (fast, no
// network on the common no-match turn). This module only keeps that local
// cache fresh from a remote akg server — a TTL-gated, bounded index refresh
// plus a per-doc fetch-on-match with a hard timeout, ETag reuse (304 costs
// ~0 bytes), and fail-open fallback to whatever is already on disk.
//
// Every exported function is best-effort and NEVER throws: a down server, a
// timeout, a missing token, or a malformed response all leave the local cache
// exactly as it was and let the caller fall back to it (same contract as
// akg's own CLI `sync.mjs` in the agent-knowledge-governance repo — this
// module does not import that repo, per the D1 separation boundary; the
// contract is the HTTP API + file layout, not shared code).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const DEFAULT_TIMEOUT_MS = 400;
const DEFAULT_INDEX_TTL_MS = 5 * 60 * 1000;

// Token: an explicit hub.token wins (mainly for tests), then AKG_TOKEN, then
// the akg CLI's own token file — B모드 and `akg sync` (A모드) talk to the same
// server, so they share one token.
export function resolveHubToken(hub) {
  if (hub && typeof hub.token === "string" && hub.token) return hub.token;
  if (process.env.AKG_TOKEN) return process.env.AKG_TOKEN;
  try {
    const t = readFileSync(join(homedir(), ".claude", "akg", "token"), "utf8").trim();
    if (t) return t;
  } catch {
    /* no token file -> unauthenticated request, server may 401 -> fail-open */
  }
  return null;
}

function cacheStatePath(indexPath) {
  return join(dirname(indexPath), ".hub-cache.json");
}

// { index: {etag, fetchedAt} | null, docs: { [entry.path]: {etag, fetchedAt} } }
export function loadCacheState(indexPath) {
  try {
    const raw = JSON.parse(readFileSync(cacheStatePath(indexPath), "utf8"));
    return {
      index: raw?.index ?? null,
      docs: raw?.docs && typeof raw.docs === "object" ? raw.docs : {},
    };
  } catch {
    return { index: null, docs: {} }; // missing/invalid -> start clean, fail-soft
  }
}

export function saveCacheState(indexPath, state) {
  try {
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(cacheStatePath(indexPath), JSON.stringify(state));
  } catch {
    /* best-effort — a lost cache write just means the next turn re-fetches */
  }
}

function authHeaders(hub) {
  const token = resolveHubToken(hub);
  return token ? { authorization: `Bearer ${token}` } : {};
}

function timeoutMsOf(hub) {
  return Number.isFinite(hub.timeoutMs) ? hub.timeoutMs : DEFAULT_TIMEOUT_MS;
}

// TTL-gated, best-effort index refresh. Bounded by hub.timeoutMs so it can
// never delay a turn past that cap; any failure (network, timeout, non-2xx,
// bad JSON) leaves indexPath and cacheState.index exactly as they were, so the
// caller reads whatever was already on disk — same content as before this
// call. Mutates cacheState.index in place on success (or on a 304, to bump
// fetchedAt so a healthy server doesn't get re-polled every turn).
export async function refreshIndexIfStale({ indexPath, hub, cacheState, now, fetchImpl = fetch }) {
  const ttl = Number.isFinite(hub.indexTtlMs) ? hub.indexTtlMs : DEFAULT_INDEX_TTL_MS;
  if (cacheState.index && now - cacheState.index.fetchedAt < ttl) return; // fresh enough

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMsOf(hub));
  try {
    const headers = { ...authHeaders(hub) };
    if (cacheState.index?.etag) headers["if-none-match"] = cacheState.index.etag;
    const url = `${String(hub.url).replace(/\/$/, "")}/api/index/${hub.type}`;
    const res = await fetchImpl(url, { headers, signal: controller.signal });

    if (res.status === 304) {
      cacheState.index = { etag: cacheState.index.etag, fetchedAt: now };
      return;
    }
    if (res.status >= 200 && res.status < 300) {
      const body = await res.text();
      const parsed = JSON.parse(body); // throws on garbage -> caught below, disk untouched
      if (!Array.isArray(parsed)) throw new Error("hub index response is not an array");
      mkdirSync(dirname(indexPath), { recursive: true });
      writeFileSync(indexPath, body);
      cacheState.index = { etag: res.headers.get("etag") ?? null, fetchedAt: now };
    }
    // other statuses (401/404/5xx/...) -> leave cache untouched, retry next turn
  } catch {
    // network error, abort/timeout, or bad JSON -> leave cache untouched
  } finally {
    clearTimeout(timer);
  }
}

const idFromRelPath = (relPath) => basename(String(relPath)).replace(/\.md$/, "");

// Ensure `abs` holds the freshest reachable copy of the doc at `relPath` (the
// index entry's `path`, relative to the index's folder — stable across
// machines and across the full/pointer entry split, unlike `abs`). Mutates
// cacheState.docs[relPath] in place on a fresh fetch or a 304.
//
// Returns true when `abs` has SOME usable content afterward (fresh fetch, a
// 304 confirming the cached copy, or a fallback to whatever was already on
// disk); false only when neither a fetch nor a local file is available — the
// caller then skips this candidate silently (design §8.3 point 3).
export async function fetchDocFresh({ abs, relPath, hub, cacheState, fetchImpl = fetch }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMsOf(hub));
  try {
    const cached = cacheState.docs[relPath];
    const headers = { ...authHeaders(hub) };
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    const id = idFromRelPath(relPath);
    const url = `${String(hub.url).replace(/\/$/, "")}/api/docs/${hub.type}/${encodeURIComponent(id)}?format=md`;
    const res = await fetchImpl(url, { headers, signal: controller.signal });

    if (res.status === 304) {
      cacheState.docs[relPath] = { etag: cached?.etag ?? null, fetchedAt: Date.now() };
      return existsSync(abs);
    }
    if (res.status >= 200 && res.status < 300) {
      const body = await res.text();
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
      cacheState.docs[relPath] = { etag: res.headers.get("etag") ?? null, fetchedAt: Date.now() };
      return true;
    }
    // other statuses -> fall through to the local fallback below
  } catch {
    // network error / timeout -> fall through to the local fallback below
  } finally {
    clearTimeout(timer);
  }
  return existsSync(abs); // fail-open: whatever was already cached, or nothing
}
