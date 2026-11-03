// Pulls the team's open revisions and their transaction history from Phabricator.
//
// Transaction history is the expensive part (one or more requests per revision), so it is
// cached between runs keyed by revision PHID and only re-fetched when the revision's
// dateModified changes. Re-fetches are incremental: we page newest-first until we reach a
// transaction we already have.

import { BudgetExceededError, searchAll } from './conduit.js';

export const OPEN_STATUSES = ['needs-review', 'needs-revision', 'changes-planned', 'accepted'];
const BOARD_STATUSES = [...OPEN_STATUSES, 'draft'];

// Reviewer states that mean "this reviewer still owes a look at the current diff".
export const PENDING_REVIEWER = new Set(['added', 'blocking', 'accepted-prior', 'rejected-prior']);

// Reviewers on a draft aren't notified until it's published, so nobody owes a review yet.
export function owesReview(rev, teamOrGroup) {
  return rev.status === 'needs-review' && !rev.isDraft
    && rev.reviewers.some((r) => teamOrGroup.has(r.phid) && PENDING_REVIEWER.has(r.status));
}

// Whether a revision belongs on the board: the team wrote it, owes a review on it, or is
// a reviewer on someone else's draft.
export function isRelevant(rev, team, teamOrGroup) {
  return team.has(rev.author)
    || owesReview(rev, teamOrGroup)
    || (rev.isDraft && rev.reviewers.some((r) => teamOrGroup.has(r.phid)));
}

// Transaction types worth keeping. Everything else (subscribers, projects, untyped
// bookkeeping rows) is noise for our purposes.
const KEPT_TYPES = new Set([
  'create', 'update', 'comment', 'inline', 'accept', 'request-changes', 'request-review',
  'plan-changes', 'close', 'abandon', 'reclaim', 'reopen', 'status', 'resign', 'commandeer',
  'reviewers',
]);

// Kept low to stay polite to Phabricator, which rate-limits per user.
const CONCURRENCY = 3;

export function emptyCache() {
  return { version: 1, revisions: {}, names: {} };
}

export async function collect({ conduit, config, cache = emptyCache() }) {
  // PHIDs whose name-cache entry was added or changed this run.
  const touchedNames = new Set();
  const users = await searchAll(conduit, 'user.search', {
    constraints: { usernames: [...config.members, ...config.ignoreUsers] },
  });
  for (const u of users) {
    const prev = cache.names[u.phid];
    if (prev?.name !== u.fields.username || prev?.fullName !== u.fields.realName) touchedNames.add(u.phid);
    cache.names[u.phid] = { ...prev, name: u.fields.username, fullName: u.fields.realName, type: 'USER' };
  }
  const byName = new Map(users.map((u) => [u.fields.username.toLowerCase(), u.phid]));
  const lookup = (names) => names.map((n) => byName.get(n.toLowerCase())).filter(Boolean);
  const teamPhids = lookup(config.members);
  const ignoredPhids = lookup(config.ignoreUsers);
  const missing = config.members.filter((n) => !byName.has(n.toLowerCase()));

  let groupPhids = [];
  if (config.reviewerGroups.length) {
    const groups = await searchAll(conduit, 'project.search', {
      constraints: { slugs: config.reviewerGroups },
    });
    groupPhids = groups.map((g) => g.phid);
  }

  const revisions = new Map();
  const add = (rows) => rows.forEach((r) => revisions.set(r.phid, normalizeRevision(r)));
  const search = (constraints) =>
    searchAll(conduit, 'differential.revision.search', {
      constraints,
      attachments: { reviewers: true },
      order: 'updated',
    });

  if (teamPhids.length) {
    add(await search({ authorPHIDs: teamPhids, statuses: BOARD_STATUSES }));
    add(await search({ reviewerPHIDs: [...teamPhids, ...groupPhids], statuses: ['needs-review', 'draft'] }));
  }

  // The reviewer query also matches revisions where the team member or group has already
  // reviewed. Drop those before paying for their history.
  const teamOrGroup = new Set([...teamPhids, ...groupPhids]);
  const team = new Set(teamPhids);
  for (const [phid, rev] of revisions) {
    if (!isRelevant(rev, team, teamOrGroup)) revisions.delete(phid);
  }

  const { updated, incomplete, errors, budgetHit } = await syncHistory(conduit, cache, [...revisions.values()]);
  const removed = [];

  // Drop cache entries for revisions that are no longer in the queue.
  for (const phid of Object.keys(cache.revisions)) {
    if (!revisions.has(phid)) {
      delete cache.revisions[phid];
      removed.push(phid);
    }
  }

  const events = {};
  for (const phid of revisions.keys()) events[phid] = cache.revisions[phid]?.events ?? [];

  const cosmetic = await resolveCosmetics(conduit, cache, revisions, events, teamPhids, touchedNames);
  errors.push(...cosmetic.errors);

  return {
    revisions: [...revisions.values()],
    events,
    names: cache.names,
    teamPhids,
    groupPhids,
    ignoredPhids,
    missingMembers: missing,
    incomplete,
    errors,
    budgetHit: budgetHit || cosmetic.budgetHit,
    requests: conduit.used,
    cache,
    // What changed in the cache this run, so persistent stores can write just the delta.
    changes: {
      updated,
      removed,
      names: [...touchedNames],
    },
  };
}

// Re-fetches one revision, for refreshing a single card. `team` is the { teamPhids,
// groupPhids } found by the last collect(). `revision` comes back null when the revision no
// longer belongs on the board (landed, abandoned, review done), and its cache entry is
// dropped.
export async function collectRevision({ conduit, phid, team, cache = emptyCache() }) {
  const touchedNames = new Set();
  const { data } = await conduit.call('differential.revision.search', {
    constraints: { phids: [phid] },
    attachments: { reviewers: true },
  });
  const rev = data[0] && normalizeRevision(data[0]);
  const teamOrGroup = new Set([...team.teamPhids, ...team.groupPhids]);
  const relevant = rev && BOARD_STATUSES.includes(rev.status)
    && isRelevant(rev, new Set(team.teamPhids), teamOrGroup);
  if (!relevant) {
    delete cache.revisions[phid];
    return { revision: null, events: [], incomplete: false, errors: [], budgetHit: false,
      requests: conduit.used, cache, changes: { names: [] } };
  }

  const sync = await syncHistory(conduit, cache, [rev]);
  const events = cache.revisions[phid]?.events ?? [];
  const cosmetic = await resolveCosmetics(
    conduit, cache, new Map([[phid, rev]]), { [phid]: events }, [], touchedNames);
  return {
    revision: rev,
    events,
    incomplete: sync.incomplete.length > 0,
    errors: [...sync.errors, ...cosmetic.errors],
    budgetHit: sync.budgetHit || cosmetic.budgetHit,
    requests: conduit.used,
    cache,
    changes: { names: [...touchedNames] },
  };
}

// Brings cached history up to date for the revisions that changed since it was fetched,
// most recent first.
async function syncHistory(conduit, cache, revs) {
  const stale = revs
    .filter((r) => cache.revisions[r.phid]?.modified !== r.dateModified)
    .sort((a, b) => b.dateModified - a.dateModified);

  const incomplete = [];
  const updated = [];
  const errors = [];
  let budgetHit = false;
  await pool(stale, CONCURRENCY, async (rev) => {
    if (budgetHit) return incomplete.push(rev.phid);
    const prev = cache.revisions[rev.phid];
    try {
      const { events, maxId } = await fetchEvents(conduit, rev.phid, prev?.maxId ?? 0);
      cache.revisions[rev.phid] = {
        modified: rev.dateModified,
        maxId: Math.max(maxId, prev?.maxId ?? 0),
        events: mergeEvents(prev?.events ?? [], events),
      };
      updated.push(rev.phid);
    } catch (err) {
      // Keep going: a revision without fresh history falls back to cached events (if any)
      // and is retried on the next refresh.
      if (err instanceof BudgetExceededError) budgetHit = true;
      else errors.push(`D${rev.id}: ${err.message}`);
      incomplete.push(rev.phid);
    }
  });
  return { updated, incomplete, errors, budgetHit };
}

// Names and avatars are cosmetic: on failure fall back to PHIDs and initials rather than
// failing the refresh.
async function resolveCosmetics(conduit, cache, revisions, events, extraPhids, touched) {
  try {
    await resolveNames(conduit, cache, revisions, events, touched);
    await resolveAvatars(conduit, cache, [...extraPhids, ...avatarPhids(revisions)], touched);
    return { errors: [], budgetHit: false };
  } catch (err) {
    if (err instanceof BudgetExceededError) return { errors: [], budgetHit: true };
    return { errors: [err.message], budgetHit: false };
  }
}

function normalizeRevision(r) {
  const f = r.fields;
  return {
    phid: r.phid,
    id: r.id,
    title: f.title,
    uri: f.uri,
    author: f.authorPHID,
    status: f.status.value,
    // A draft can carry another status (e.g. changes-planned), so check the flag too.
    isDraft: Boolean(f.isDraft) || f.status.value === 'draft',
    statusName: f.status.name,
    dateCreated: f.dateCreated,
    dateModified: f.dateModified,
    bug: f['bugzilla.bug-id'] || null,
    reviewers: (r.attachments?.reviewers?.reviewers ?? []).map((rv) => ({
      phid: rv.reviewerPHID,
      status: rv.status,
      blocking: rv.isBlocking,
      actor: rv.actorPHID,
    })),
  };
}

async function fetchEvents(conduit, phid, sinceId) {
  const events = [];
  let maxId = 0;
  let after = null;
  for (let page = 0; page < 10; page++) {
    const result = await conduit.call('transaction.search', {
      objectIdentifier: phid,
      limit: 100,
      ...(after ? { after } : {}),
    });
    let reachedKnown = false;
    for (const tx of result.data) {
      maxId = Math.max(maxId, tx.id);
      if (tx.id <= sinceId) {
        reachedKnown = true;
        break;
      }
      if (!KEPT_TYPES.has(tx.type)) continue;
      const e = { id: tx.id, t: tx.type, a: tx.authorPHID, d: tx.dateCreated };
      if (tx.type === 'status') e.s = tx.fields?.new;
      events.push(e);
    }
    after = result.cursor?.after;
    if (reachedKnown || !after) break;
  }
  return { events, maxId };
}

function mergeEvents(old, fresh) {
  const seen = new Set(old.map((e) => e.id));
  return [...old, ...fresh.filter((e) => !seen.has(e.id))].sort((a, b) => a.d - b.d || a.id - b.id);
}

async function resolveNames(conduit, cache, revisions, events, touched) {
  const wanted = new Set();
  for (const r of revisions.values()) {
    wanted.add(r.author);
    r.reviewers.forEach((rv) => wanted.add(rv.phid));
  }
  for (const list of Object.values(events)) list.forEach((e) => wanted.add(e.a));
  const unknown = [...wanted].filter((p) => p && !cache.names[p]);
  for (let i = 0; i < unknown.length; i += 100) {
    const result = await conduit.call('phid.query', { phids: unknown.slice(i, i + 100) });
    for (const [phid, info] of Object.entries(result)) {
      cache.names[phid] = { name: info.name, fullName: info.fullName, type: info.type };
      touched.add(phid);
    }
  }
}

// Users shown with an avatar on the board: authors and reviewers.
function avatarPhids(revisions) {
  const phids = new Set();
  for (const r of revisions.values()) {
    phids.add(r.author);
    r.reviewers.forEach((rv) => phids.add(rv.phid));
  }
  return [...phids];
}

// Profile image URLs come from the older user.query method; user.search doesn't expose
// them. `image` is '' once looked up with no result, so each user is only fetched once.
async function resolveAvatars(conduit, cache, phids, touched) {
  const missing = [...new Set(phids)].filter(
    (p) => p?.startsWith('PHID-USER-') && cache.names[p] && cache.names[p].image === undefined,
  );
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const users = await conduit.call('user.query', { phids: batch, limit: batch.length });
    const images = new Map(users.map((u) => [u.phid, u.image]));
    for (const phid of batch) {
      cache.names[phid].image = images.get(phid) || '';
      touched.add(phid);
    }
  }
}

async function pool(items, size, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}
