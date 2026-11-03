import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collect, collectRevision, emptyCache } from '../site/lib/collect.js';

const config = { members: ['me'], ignoreUsers: [], reviewerGroups: [], staleDays: 7 };

const revision = {
  id: 1, phid: 'PHID-DREV-1',
  fields: {
    title: 'Bug 1 - Thing', uri: 'https://phab/D1', authorPHID: 'PHID-USER-me',
    status: { value: 'needs-review', name: 'Needs Review' }, dateCreated: 1, dateModified: 2,
  },
  attachments: { reviewers: { reviewers: [{ reviewerPHID: 'PHID-USER-out', status: 'added', isBlocking: false }] } },
};

// Fake Conduit that answers the handful of methods collect() uses and records calls.
function fakeConduit({ userQuery, revisionSearch } = {}) {
  const calls = [];
  const handlers = {
    'user.search': () => ({ data: [{ phid: 'PHID-USER-me', fields: { username: 'me', realName: 'Me' } }], cursor: {} }),
    'differential.revision.search': revisionSearch
      ?? ((p) => ({ data: p.constraints.authorPHIDs || p.constraints.phids ? [revision] : [], cursor: {} })),
    'transaction.search': () => ({ data: [], cursor: {} }),
    'phid.query': () => ({ 'PHID-USER-out': { name: 'out', fullName: 'Out Sider', type: 'USER' } }),
    'user.query': userQuery ?? (() => [{ phid: 'PHID-USER-me', image: 'https://img/me.png' }]),
  };
  return {
    calls,
    used: 0,
    async call(method, params) {
      calls.push(method);
      this.used++;
      return handlers[method](params);
    },
  };
}

test('looks up avatars once and remembers users without one', async () => {
  const conduit = fakeConduit();
  const cache = emptyCache();
  const first = await collect({ conduit, config, cache });

  assert.equal(cache.names['PHID-USER-me'].image, 'https://img/me.png');
  assert.equal(cache.names['PHID-USER-out'].image, '');
  assert.deepEqual(first.changes.names.sort(), ['PHID-USER-me', 'PHID-USER-out']);

  const again = fakeConduit();
  const second = await collect({ conduit: again, config, cache });
  assert.ok(!again.calls.includes('user.query'), 'avatars should come from the cache');
  // Refreshing the team's names from user.search must not wipe the cached image.
  assert.equal(cache.names['PHID-USER-me'].image, 'https://img/me.png');
  assert.deepEqual(second.changes.names, []);
});

test('a failing avatar lookup does not fail the refresh', async () => {
  const conduit = fakeConduit({ userQuery: () => { throw new Error('user.query: ERR-CONDUIT-CALL'); } });
  const cache = emptyCache();
  const result = await collect({ conduit, config, cache });

  assert.equal(result.revisions.length, 1);
  assert.deepEqual(result.errors, ['user.query: ERR-CONDUIT-CALL']);
  // Left unset so the next refresh tries again.
  assert.equal(cache.names['PHID-USER-me'].image, undefined);
});

const team = { teamPhids: ['PHID-USER-me'], groupPhids: [] };

test('refreshing one card fetches just that revision', async () => {
  const conduit = fakeConduit();
  const cache = emptyCache();
  const result = await collectRevision({ conduit, phid: revision.phid, team, cache });

  assert.equal(result.revision.id, 1);
  assert.equal(result.incomplete, false);
  assert.deepEqual(cache.revisions[revision.phid], { modified: 2, maxId: 0, events: [] });
  assert.deepEqual(conduit.calls, ['differential.revision.search', 'transaction.search', 'phid.query', 'user.query']);
  assert.ok(!conduit.calls.includes('user.search'), 'team lookup comes from the cached board');
});

test('refreshing an unchanged card skips its history', async () => {
  const cache = emptyCache();
  cache.revisions[revision.phid] = { modified: 2, maxId: 5, events: [] };
  cache.names['PHID-USER-me'] = { name: 'me', type: 'USER', image: '' };
  cache.names['PHID-USER-out'] = { name: 'out', type: 'USER', image: '' };
  const conduit = fakeConduit();
  await collectRevision({ conduit, phid: revision.phid, team, cache });
  assert.deepEqual(conduit.calls, ['differential.revision.search']);
});

test('a landed revision drops off when its card is refreshed', async () => {
  const landed = { ...revision, fields: { ...revision.fields, status: { value: 'published', name: 'Closed' } } };
  const conduit = fakeConduit({ revisionSearch: () => ({ data: [landed], cursor: {} }) });
  const cache = emptyCache();
  cache.revisions[revision.phid] = { modified: 1, maxId: 5, events: [] };
  const result = await collectRevision({ conduit, phid: revision.phid, team, cache });

  assert.equal(result.revision, null);
  assert.equal(cache.revisions[revision.phid], undefined);
  assert.deepEqual(conduit.calls, ['differential.revision.search']);
});
