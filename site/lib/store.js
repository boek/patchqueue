// Shared cache in Quick's per-site storage, so every viewer sees the same board and a
// refresh by anyone updates everyone's page live.
//
//   quick.db   'revisions'     one doc per revision on the board:
//                              { phid, rev, history, incomplete, savedAt }
//                              `history` is the transaction cache entry from collect.js
//                              ({ modified, maxId, events }), or null before it's fetched.
//   quick.data 'names'         PHID -> { name, fullName, type, image }
//   quick.data 'board'         team PHIDs and stats from the last full refresh
//   quick.data 'refresh_lock'  { by, at } while someone runs a full refresh

import { emptyCache } from './collect.js';

// A full refresh holding the lock longer than this is assumed to have died with its tab.
export const LOCK_TTL = 5 * 60;

// Writes to quick.db in flight at once.
const WRITE_CONCURRENCY = 6;

export function createStore(quick, { now = () => Date.now() } = {}) {
  const revisions = quick.db.collection('revisions');
  const nowS = () => Math.floor(now() / 1000);
  const state = { docs: new Map(), names: {}, board: null, lock: null };

  // Loads everything and keeps `state` current as anyone writes. `onChange` fires after
  // every change; the revision subscription replays existing docs as creates first.
  async function start(onChange) {
    const [names, board, lock] = await Promise.all(
      ['names', 'board', 'refresh_lock'].map((k) => quick.data.get(k)));
    Object.assign(state, { names: names ?? {}, board, lock });
    quick.data.subscribe('names', (v) => { state.names = v ?? {}; onChange(); });
    quick.data.subscribe('board', (v) => { state.board = v; onChange(); });
    quick.data.subscribe('refresh_lock', (v) => { state.lock = v; onChange(); });
    revisions.subscribe({
      onCreate: (doc) => { state.docs.set(doc.id, doc); onChange(); },
      onUpdate: (doc) => { state.docs.set(doc.id, doc); onChange(); },
      onDelete: (id) => { state.docs.delete(id); onChange(); },
    });
    onChange();
  }

  // The input analyze() expects, rebuilt from the cache.
  function toData() {
    const docs = [...latestByPhid(state.docs.values()).values()];
    const board = state.board ?? {};
    return {
      revisions: docs.map((d) => d.rev),
      events: Object.fromEntries(docs.map((d) => [d.phid, d.history?.events ?? []])),
      names: state.names,
      teamPhids: board.teamPhids ?? [],
      groupPhids: board.groupPhids ?? [],
      ignoredPhids: board.ignoredPhids ?? [],
      missingMembers: board.missingMembers ?? [],
      incomplete: docs.filter((d) => d.incomplete).map((d) => d.phid),
      errors: board.errors ?? [],
      budgetHit: Boolean(board.budgetHit),
      requests: board.requests ?? 0,
    };
  }

  // The transaction cache collect() reads and updates.
  function toCache(docs = state.docs.values()) {
    const cache = emptyCache();
    for (const d of latestByPhid(docs).values()) if (d.history) cache.revisions[d.phid] = d.history;
    cache.names = structuredClone(state.names);
    return cache;
  }

  // Fresh docs straight from the database, for a full refresh to diff against.
  const listDocs = () => revisions.list();

  // Writes a collect() result: creates, rewrites or deletes revision docs so the
  // collection matches the board, and stores names and board stats.
  async function saveFull(result, docs) {
    const existing = groupByPhid(docs);
    const incomplete = new Set(result.incomplete);
    const ops = [];
    for (const rev of result.revisions) {
      const body = docBody(rev, result.cache.revisions[rev.phid], incomplete.has(rev.phid));
      ops.push(...writeDoc(existing.get(rev.phid) ?? [], body));
    }
    const keep = new Set(result.revisions.map((r) => r.phid));
    for (const [phid, list] of existing) {
      if (!keep.has(phid)) ops.push(...list.map((d) => () => revisions.delete(d.id)));
    }
    await pool(ops, WRITE_CONCURRENCY);

    const referenced = referencedPhids(result);
    await saveNames(result.cache.names, result.changes.names, (phid) => referenced.has(phid));
    await quick.data.set('board', {
      teamPhids: result.teamPhids,
      groupPhids: result.groupPhids,
      ignoredPhids: result.ignoredPhids,
      missingMembers: result.missingMembers,
      errors: result.errors.slice(0, 10),
      budgetHit: result.budgetHit,
      requests: result.requests,
      refreshedAt: nowS(),
      refreshedBy: result.refreshedBy ?? null,
    });
  }

  // Writes a collectRevision() result for one card.
  async function saveRevision(phid, result) {
    const docs = [...state.docs.values()].filter((d) => d.phid === phid);
    const ops = result.revision
      ? writeDoc(docs, docBody(result.revision, result.cache.revisions[phid], result.incomplete))
      : docs.map((d) => () => revisions.delete(d.id));
    await pool(ops, WRITE_CONCURRENCY);
    await saveNames(result.cache.names, result.changes.names);
  }

  // Merges into whatever is stored now, so a concurrent single-card refresh isn't lost.
  // `keep` prunes names nobody on the board uses any more, to stay under the value cap.
  async function saveNames(names, touched, keep = null) {
    if (!touched.length && !keep) return;
    await quick.data.update('names', (cur) => {
      const next = { ...cur };
      for (const phid of touched) next[phid] = names[phid];
      if (keep) for (const phid of Object.keys(next)) if (!keep(phid)) delete next[phid];
      return next;
    });
  }

  // One doc per revision: rewrite the newest only if something changed, and clear out
  // duplicates left by two people refreshing at once.
  function writeDoc(docs, body) {
    const [first, ...dupes] = docs;
    const ops = dupes.map((d) => () => revisions.delete(d.id));
    const doc = { ...body, savedAt: nowS() };
    if (!first) ops.push(() => revisions.create(doc));
    else if (!sameDoc(first, body)) ops.push(() => revisions.replace(first.id, doc));
    return ops;
  }

  // True if this browser got the lock. A lock older than LOCK_TTL is taken over.
  async function acquireLock(by) {
    let got = false;
    await quick.data.update('refresh_lock', (cur) => {
      got = !cur || cur.by === by || nowS() - cur.at > LOCK_TTL;
      return got ? { by, at: nowS() } : cur;
    });
    return got;
  }

  const releaseLock = () => quick.data.delete('refresh_lock');

  return { state, start, toData, toCache, listDocs, saveFull, saveRevision, acquireLock, releaseLock };
}

function docBody(rev, history, incomplete) {
  return { phid: rev.phid, rev, history: history ?? null, incomplete };
}

function sameDoc(doc, body) {
  return JSON.stringify([doc.rev, doc.history, doc.incomplete])
    === JSON.stringify([body.rev, body.history, body.incomplete]);
}

// phid -> docs, newest first.
function groupByPhid(docs) {
  const map = new Map();
  for (const d of docs) map.set(d.phid, [...(map.get(d.phid) ?? []), d]);
  for (const list of map.values()) list.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
  return map;
}

function latestByPhid(docs) {
  const map = new Map();
  for (const [phid, list] of groupByPhid(docs)) map.set(phid, list[0]);
  return map;
}

// Everyone the board can show or needs a name for.
function referencedPhids(result) {
  const phids = new Set([...result.teamPhids, ...result.groupPhids, ...result.ignoredPhids]);
  for (const r of result.revisions) {
    phids.add(r.author);
    r.reviewers.forEach((rv) => phids.add(rv.phid));
  }
  for (const list of Object.values(result.events)) list.forEach((e) => phids.add(e.a));
  return phids;
}

async function pool(tasks, size) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, tasks.length) }, async () => {
    while (next < tasks.length) await tasks[next++]();
  });
  await Promise.all(workers);
}
