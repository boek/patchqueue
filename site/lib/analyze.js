// Turns collected revisions + transaction history into the report the dashboard renders.
// Pure function of its inputs, so it is easy to test against fixtures.

import { isRelevant, owesReview, PENDING_REVIEWER } from './collect.js';

const DAY = 86400;

// Fallback transaction types that move a revision into each status, for history that
// predates the explicit `status` transaction.
const ENTERS_STATUS = {
  'needs-review': ['request-review', 'reclaim', 'reopen', 'create'],
  'needs-revision': ['request-changes'],
  'changes-planned': ['plan-changes'],
  accepted: ['accept'],
};

export const CATEGORIES = {
  'needs-review': 'Needs review by team',
  'author-action': 'Author must respond',
  'ready-to-land': 'Ready to land',
  stale: 'Stale',
  wip: 'Drafts',
};

export function analyze(data, config, now = Date.now()) {
  const nowS = Math.floor(now / 1000);
  const team = new Set(data.teamPhids);
  const teamOrGroup = new Set([...data.teamPhids, ...data.groupPhids]);
  const ignored = new Set(data.ignoredPhids);
  const isHuman = (phid) => phid?.startsWith('PHID-USER-') && !ignored.has(phid);
  const nameOf = (phid) => data.names[phid]?.name ?? phid;
  const hiddenReviewers = new Set(config.ignoreReviewers ?? []);
  const revisions = data.revisions.map((rev) => ({
    ...rev,
    reviewers: rev.reviewers.filter((r) => !hiddenReviewers.has(nameOf(r.phid))),
  }));

  const items = [];
  for (const rev of revisions) {
    const ev = (data.events[rev.phid] ?? []).filter((e) => isHuman(e.a));
    const teamAuthor = team.has(rev.author);
    if (!isRelevant(rev, team, teamOrGroup)) continue;
    const needsReview = rev.status === 'needs-review' && !rev.isDraft;
    const pending = needsReview ? rev.reviewers.filter((r) => PENDING_REVIEWER.has(r.status)) : [];

    const last = ev.at(-1);
    const lastActivity = last
      ? { at: last.d, by: nameOf(last.a), type: last.t }
      : { at: rev.dateModified, by: null, type: null };

    const categories = [];
    const reasons = [];
    let waitingOn = needsReview ? 'reviewers' : 'author';
    let waitingSince = enteredStatus(rev, ev) ?? rev.dateCreated;

    if (rev.isDraft) {
      // Drafts go in their own section only, so they don't crowd the actionable ones.
      categories.push('wip');
    } else {
      if (owesReview(rev, teamOrGroup)) {
        categories.push('needs-review');
      }
      if (teamAuthor && rev.status === 'needs-revision') {
        categories.push('author-action');
        reasons.push('Changes requested');
      }
      if (teamAuthor && rev.status === 'changes-planned') {
        categories.push('author-action');
        reasons.push('Changes planned');
      }
      if (teamAuthor && needsReview) {
        // A reviewer left comments without changing the status, and the author hasn't
        // replied or updated since.
        const lastByAuthor = ev.findLast((e) => e.a === rev.author)?.d ?? 0;
        const unanswered = ev.filter(
          (e) => e.a !== rev.author && (e.t === 'comment' || e.t === 'inline') && e.d > lastByAuthor,
        );
        if (unanswered.length) {
          categories.push('author-action');
          reasons.push('Unanswered comments');
          waitingOn = 'author';
          waitingSince = unanswered[0].d;
        }
      }
      if (teamAuthor && rev.status === 'accepted') {
        categories.push('ready-to-land');
      }
      if (nowS - lastActivity.at > config.staleDays * DAY) {
        categories.push('stale');
      }
    }

    items.push({
      phid: rev.phid,
      id: rev.id,
      title: rev.title,
      uri: rev.uri,
      bug: rev.bug,
      author: nameOf(rev.author),
      authorIsTeam: teamAuthor,
      status: rev.status,
      statusName: rev.statusName,
      categories,
      reasons,
      waitingOn,
      waitingFor: waitingOn === 'author' ? [nameOf(rev.author)] : pending.map((r) => nameOf(r.phid)),
      waitingSince,
      lastActivity,
      reviewers: rev.reviewers.map((r) => ({
        name: nameOf(r.phid),
        status: r.status,
        blocking: r.blocking,
        team: teamOrGroup.has(r.phid),
        pending: pending.includes(r),
      })),
      incomplete: data.incomplete.includes(rev.phid),
    });
  }
  items.sort((a, b) => a.waitingSince - b.waitingSince);

  const members = data.teamPhids.map((p) => {
    const username = nameOf(p);
    return {
      username,
      fullName: data.names[p]?.fullName ?? '',
      authored: items.filter((i) => i.author === username).length,
      reviewsOwed: items.filter((i) => !i.categories.includes('wip')
        && i.reviewers.some((r) => r.pending && r.name === username)).length,
    };
  });

  // username -> profile image URL, for everyone shown on the board who has one.
  const avatars = {};
  const imageByName = new Map(
    Object.values(data.names).filter((n) => n.type === 'USER' && n.image).map((n) => [n.name, n.image]),
  );
  const shown = [...members.map((m) => m.username), ...items.flatMap((i) => [i.author, ...i.reviewers.map((r) => r.name)])];
  for (const name of shown) {
    if (imageByName.has(name)) avatars[name] = imageByName.get(name);
  }

  return {
    generatedAt: nowS,
    config: { staleDays: config.staleDays },
    members,
    avatars,
    missingMembers: data.missingMembers,
    items,
    meta: {
      requests: data.requests,
      incomplete: data.incomplete.length,
      budgetHit: data.budgetHit,
      errors: data.errors.slice(0, 10),
    },
  };
}

function enteredStatus(rev, ev) {
  const explicit = ev.findLast((e) => e.t === 'status' && e.s === rev.status);
  if (explicit) return explicit.d;
  const types = ENTERS_STATUS[rev.status] ?? [];
  return ev.findLast((e) => types.includes(e.t))?.d ?? null;
}
