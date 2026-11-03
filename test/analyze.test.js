import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze } from '../site/lib/analyze.js';

const DAY = 86400;
const NOW = 1_800_000_000;
const ME = 'PHID-USER-me';
const MATE = 'PHID-USER-mate';
const OUTSIDER = 'PHID-USER-out';
const BOT = 'PHID-USER-bot';
const GROUP = 'PHID-PROJ-group';

const config = { staleDays: 7 };
const names = {
  [ME]: { name: 'me' }, [MATE]: { name: 'mate' }, [OUTSIDER]: { name: 'out' },
  [BOT]: { name: 'phab-bot' }, [GROUP]: { name: 'team-reviewers' },
};

let nextId = 1;
const ev = (t, a, daysAgo, extra = {}) => ({ id: nextId++, t, a, d: NOW - daysAgo * DAY, ...extra });
const rev = (id, author, status, reviewers = []) => ({
  phid: `PHID-DREV-${id}`, id, title: `D${id}`, uri: `https://phab/D${id}`, author, status,
  statusName: status, isDraft: status === 'draft', dateCreated: NOW - 30 * DAY, dateModified: NOW, bug: null,
  reviewers: reviewers.map(([phid, status]) => ({ phid, status, blocking: false, actor: null })),
});

function run(revisions, events) {
  return analyze({
    revisions, events, names, teamPhids: [ME, MATE], groupPhids: [GROUP], ignoredPhids: [BOT],
    missingMembers: [], incomplete: [], errors: [], budgetHit: false, requests: 0,
  }, config, NOW * 1000);
}
const byId = (report, id) => report.items.find((i) => i.id === id);

test('outsider patch with a pending team group reviewer needs review', () => {
  const r = rev(1, OUTSIDER, 'needs-review', [[GROUP, 'blocking']]);
  const report = run([r], { [r.phid]: [ev('create', OUTSIDER, 3), ev('request-review', OUTSIDER, 2)] });
  const item = byId(report, 1);
  assert.deepEqual(item.categories, ['needs-review']);
  assert.equal(item.waitingOn, 'reviewers');
  assert.equal(item.waitingSince, NOW - 2 * DAY);
});

test('changes requested on a team patch is on the author, timed from the status change', () => {
  const r = rev(2, ME, 'needs-revision', [[OUTSIDER, 'rejected']]);
  const report = run([r], { [r.phid]: [
    ev('create', ME, 5),
    ev('request-changes', OUTSIDER, 4), ev('status', OUTSIDER, 4, { s: 'needs-revision' }),
  ] });
  const item = byId(report, 2);
  assert.deepEqual(item.categories, ['author-action']);
  assert.deepEqual(item.reasons, ['Changes requested']);
  assert.equal(item.waitingSince, NOW - 4 * DAY);
});

test('reviewer comment the author has not answered flags author action', () => {
  const r = rev(3, MATE, 'needs-review', [[OUTSIDER, 'added']]);
  const report = run([r], { [r.phid]: [ev('create', MATE, 3), ev('inline', OUTSIDER, 1)] });
  const item = byId(report, 3);
  assert.deepEqual(item.categories, ['author-action']);
  assert.equal(item.waitingOn, 'author');
  assert.equal(item.waitingSince, NOW - 1 * DAY);
});

test('accepted team patch is ready to land', () => {
  const r = rev(4, ME, 'accepted', [[OUTSIDER, 'accepted']]);
  const report = run([r], { [r.phid]: [ev('create', ME, 3), ev('accept', OUTSIDER, 1)] });
  assert.deepEqual(byId(report, 4).categories, ['ready-to-land']);
});

test('bot activity does not keep a revision fresh', () => {
  const r = rev(5, ME, 'accepted', [[OUTSIDER, 'accepted']]);
  const report = run([r], { [r.phid]: [ev('accept', OUTSIDER, 10), ev('comment', BOT, 0)] });
  const item = byId(report, 5);
  assert.deepEqual(item.categories, ['ready-to-land', 'stale']);
  assert.equal(item.lastActivity.by, 'out');
});

test('outsider patch the team already reviewed is not listed', () => {
  const r = rev(6, OUTSIDER, 'needs-review', [[MATE, 'accepted'], [OUTSIDER, 'added']]);
  const report = run([r], { [r.phid]: [ev('create', OUTSIDER, 3)] });
  assert.equal(byId(report, 6), undefined);
});

test('drafts only appear as work in progress', () => {
  const draft = rev(9, ME, 'draft', [[MATE, 'added']]);
  const report = run([draft], { [draft.phid]: [ev('create', ME, 30)] });
  const item = byId(report, 9);
  assert.deepEqual(item.categories, ['wip']);
  // Not stale, and a reviewer on a draft doesn't owe a review yet.
  assert.equal(report.members[1].reviewsOwed, 0);
});

test('anything flagged as a draft is a draft, whatever its status', () => {
  const planned = { ...rev(30, ME, 'changes-planned'), isDraft: true };
  const held = { ...rev(31, ME, 'needs-review', [[MATE, 'added']]), isDraft: true };
  const report = run([planned, held], {});
  assert.deepEqual(byId(report, 30).categories, ['wip']);
  assert.deepEqual(byId(report, 31).categories, ['wip']);
  assert.equal(byId(report, 31).waitingOn, 'author');
  assert.equal(report.members[1].reviewsOwed, 0);
});

test("outsiders' drafts appear when the team is a reviewer", () => {
  const ours = rev(32, OUTSIDER, 'draft', [[GROUP, 'added']]);
  const notOurs = rev(33, OUTSIDER, 'draft', [['PHID-USER-other', 'added']]);
  const report = run([ours, notOurs], {});
  assert.deepEqual(byId(report, 32).categories, ['wip']);
  assert.equal(byId(report, 33), undefined);
});

test('changes planned is waiting on the author', () => {
  const r = rev(10, ME, 'changes-planned');
  const report = run([r], { [r.phid]: [ev('create', ME, 5), ev('plan-changes', ME, 3)] });
  const item = byId(report, 10);
  assert.deepEqual(item.categories, ['author-action']);
  assert.deepEqual(item.reasons, ['Changes planned']);
  assert.equal(item.waitingSince, NOW - 3 * DAY);
});

test('a WIP title is not treated specially', () => {
  const r = { ...rev(11, ME, 'accepted'), title: 'WIP: try a thing' };
  const report = run([r], { [r.phid]: [ev('accept', OUTSIDER, 1)] });
  assert.deepEqual(byId(report, 11).categories, ['ready-to-land']);
});

test('ignored reviewers are dropped from patches', () => {
  const r = rev(40, ME, 'needs-review', [[GROUP, 'added'], [OUTSIDER, 'added']]);
  const report = analyze({
    revisions: [r], events: {}, names, teamPhids: [ME, MATE], groupPhids: [], ignoredPhids: [BOT],
    missingMembers: [], incomplete: [], errors: [], budgetHit: false, requests: 0,
  }, { ...config, ignoreReviewers: ['team-reviewers'] }, NOW * 1000);
  const item = byId(report, 40);
  assert.deepEqual(item.reviewers.map((x) => x.name), ['out']);
  assert.deepEqual(item.waitingFor, ['out']);
});

test('per-member counts', () => {
  const a = rev(7, ME, 'accepted');
  const b = rev(8, OUTSIDER, 'needs-review', [[ME, 'added']]);
  const report = run([a, b], {});
  assert.deepEqual(report.members.map((m) => [m.username, m.authored, m.reviewsOwed]), [['me', 1, 1], ['mate', 0, 0]]);
});

test('avatars cover people on the board who have an image', () => {
  const withImages = {
    ...names,
    [ME]: { name: 'me', type: 'USER', image: 'https://img/me.png' },
    [OUTSIDER]: { name: 'out', type: 'USER', image: '' },
    [BOT]: { name: 'phab-bot', type: 'USER', image: 'https://img/bot.png' },
  };
  const r = rev(20, OUTSIDER, 'needs-review', [[ME, 'added']]);
  const report = analyze({
    revisions: [r], events: {}, names: withImages, teamPhids: [ME, MATE], groupPhids: [GROUP],
    ignoredPhids: [BOT], missingMembers: [], incomplete: [], errors: [], budgetHit: false, requests: 0,
  }, config, NOW * 1000);
  // 'out' has no image and phab-bot isn't on the board.
  assert.deepEqual(report.avatars, { me: 'https://img/me.png' });
});
