import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyCache } from '../site/lib/collect.js';
import { createStore, LOCK_TTL } from '../site/lib/store.js';

// Just enough of quick.data and quick.db, in memory, to exercise the store.
function fakeQuick() {
  const data = new Map();
  const docs = new Map();
  const writes = [];
  let nextId = 1;
  const clone = (v) => structuredClone(v);
  return {
    data: {
      get: async (k) => (data.has(k) ? clone(data.get(k)) : null),
      set: async (k, v) => { data.set(k, clone(v)); },
      delete: async (k) => { data.delete(k); },
      update: async (k, fn) => {
        const v = fn(data.has(k) ? clone(data.get(k)) : null);
        data.set(k, clone(v));
        return v;
      },
      subscribe: () => () => {},
    },
    db: {
      collection: () => ({
        list: async () => [...docs.values()].map(clone),
        create: async (d) => {
          writes.push('create');
          const doc = { ...clone(d), id: String(nextId++) };
          docs.set(doc.id, doc);
          return doc;
        },
        replace: async (id, d) => { writes.push('replace'); docs.set(id, { ...clone(d), id }); },
        delete: async (id) => { writes.push('delete'); docs.delete(id); },
        subscribe: () => () => {},
      }),
    },
    raw: { data, docs, writes },
  };
}

const rev = (n, extra = {}) => ({
  phid: `PHID-DREV-${n}`, id: n, title: `D${n}`, author: 'PHID-USER-me', status: 'needs-review',
  reviewers: [{ phid: 'PHID-USER-out', status: 'added' }], dateModified: 100, ...extra,
});

function result(revisions, { names = {}, touched = [], incomplete = [] } = {}) {
  const cache = emptyCache();
  cache.names = names;
  for (const r of revisions) {
    if (!incomplete.includes(r.phid)) cache.revisions[r.phid] = { modified: r.dateModified, maxId: 1, events: [] };
  }
  return {
    revisions, cache, incomplete,
    events: Object.fromEntries(revisions.map((r) => [r.phid, []])),
    teamPhids: ['PHID-USER-me'], groupPhids: [], ignoredPhids: [], missingMembers: [],
    errors: [], budgetHit: false, requests: 3, refreshedBy: 'Me',
    changes: { names: touched },
  };
}

// Loads what's stored the way the page does on start.
async function reload(quick) {
  const store = createStore(quick);
  for (const d of await quick.db.collection().list()) store.state.docs.set(d.id, d);
  store.state.names = (await quick.data.get('names')) ?? {};
  store.state.board = await quick.data.get('board');
  return store;
}

test('a full refresh round-trips through the cache', async () => {
  const quick = fakeQuick();
  const store = createStore(quick, { now: () => 5000_000 });
  const names = { 'PHID-USER-me': { name: 'me' }, 'PHID-USER-out': { name: 'out' } };
  await store.saveFull(result([rev(1), rev(2)], { names, touched: Object.keys(names), incomplete: ['PHID-DREV-2'] }), []);

  const loaded = await reload(quick);
  const data = loaded.toData();
  assert.deepEqual(data.revisions.map((r) => r.id).sort(), [1, 2]);
  assert.deepEqual(data.teamPhids, ['PHID-USER-me']);
  assert.deepEqual(data.incomplete, ['PHID-DREV-2']);
  assert.equal(data.names['PHID-USER-out'].name, 'out');
  assert.equal(loaded.state.board.refreshedAt, 5000);
  assert.equal(loaded.state.board.refreshedBy, 'Me');

  const cache = loaded.toCache();
  assert.deepEqual(cache.revisions['PHID-DREV-1'], { modified: 100, maxId: 1, events: [] });
  assert.equal(cache.revisions['PHID-DREV-2'], undefined, 'no history fetched yet');
});

test('a full refresh only writes revisions that changed and removes ones that left', async () => {
  const quick = fakeQuick();
  const store = createStore(quick);
  await store.saveFull(result([rev(1), rev(2), rev(3)]), []);
  quick.raw.writes.length = 0;

  const docs = await store.listDocs();
  await store.saveFull(result([rev(1), rev(2, { title: 'renamed' })]), docs);
  assert.deepEqual(quick.raw.writes.sort(), ['delete', 'replace']);
  const titles = [...quick.raw.docs.values()].map((d) => d.rev.title).sort();
  assert.deepEqual(titles, ['D1', 'renamed']);
});

test('duplicate docs from concurrent refreshes are cleaned up, keeping the newest', async () => {
  const quick = fakeQuick();
  const docsApi = quick.db.collection();
  await docsApi.create({ phid: 'PHID-DREV-1', rev: rev(1, { title: 'old' }), history: null, incomplete: false, savedAt: 1 });
  await docsApi.create({ phid: 'PHID-DREV-1', rev: rev(1, { title: 'new' }), history: null, incomplete: false, savedAt: 2 });

  const store = await reload(quick);
  assert.equal(store.toData().revisions[0].title, 'new');

  await store.saveFull(result([rev(1)]), await store.listDocs());
  assert.equal(quick.raw.docs.size, 1);
});

test('names nobody references are pruned on a full refresh', async () => {
  const quick = fakeQuick();
  await quick.data.set('names', { 'PHID-USER-gone': { name: 'gone' }, 'PHID-USER-out': { name: 'out' } });
  const store = createStore(quick);
  await store.saveFull(result([rev(1)], { names: { 'PHID-USER-me': { name: 'me' } }, touched: ['PHID-USER-me'] }), []);
  assert.deepEqual(Object.keys(await quick.data.get('names')).sort(), ['PHID-USER-me', 'PHID-USER-out']);
});

test('refreshing one card updates or deletes just that doc', async () => {
  const quick = fakeQuick();
  await createStore(quick).saveFull(result([rev(1), rev(2)]), []);
  let store = await reload(quick);
  quick.raw.writes.length = 0;

  const one = result([rev(1, { title: 'updated' })], { names: { 'PHID-USER-x': { name: 'x' } }, touched: ['PHID-USER-x'] });
  await store.saveRevision('PHID-DREV-1', { revision: one.revisions[0], cache: one.cache, incomplete: false, changes: one.changes });
  assert.deepEqual(quick.raw.writes, ['replace']);
  assert.equal((await quick.data.get('names'))['PHID-USER-x'].name, 'x');

  store = await reload(quick);
  await store.saveRevision('PHID-DREV-2', { revision: null, cache: emptyCache(), incomplete: false, changes: { names: [] } });
  const left = [...quick.raw.docs.values()].map((d) => d.rev.title);
  assert.deepEqual(left, ['updated']);
});

test('the refresh lock keeps a second person out until it expires', async () => {
  const quick = fakeQuick();
  let clock = 1_000_000;
  const store = createStore(quick, { now: () => clock });
  assert.equal(await store.acquireLock('a@x'), true);
  assert.equal(await store.acquireLock('b@x'), false);
  assert.equal(await store.acquireLock('a@x'), true, 'same person in another tab');
  clock += (LOCK_TTL + 1) * 1000;
  assert.equal(await store.acquireLock('b@x'), true, 'stale lock is taken over');
  await store.releaseLock();
  assert.equal(await quick.data.get('refresh_lock'), null);
});
