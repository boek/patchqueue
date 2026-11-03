#!/usr/bin/env node
// Prints the actionable queue in the terminal. Usage: npm run report [-- --json] [-- --wip]
import fs from 'node:fs';
import config from '../site/team.config.js';
import { CATEGORIES } from '../site/lib/analyze.js';
import { buildReport } from '../site/lib/report.js';
import { tokenFromArcrc } from './arcrc.js';

const cacheFile = new URL('../.cache/txcache.json', import.meta.url);
const token = process.env.PHABRICATOR_TOKEN ?? tokenFromArcrc(config.phabricatorUrl);
const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : undefined;

const { report, cache: next } = await buildReport({ token, config, cache });
fs.mkdirSync(new URL('../.cache/', import.meta.url), { recursive: true });
fs.writeFileSync(cacheFile, JSON.stringify(next));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const now = Date.now() / 1000;
const dur = (s) => (s == null ? '—' : s < 3600 ? `${Math.round(s / 60)}m` : s < 172800 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`);

if (report.missingMembers.length) console.log(`Unknown usernames: ${report.missingMembers.join(', ')}\n`);
const showWip = process.argv.includes('--wip');
for (const [key, label] of Object.entries(CATEGORIES)) {
  const items = report.items.filter((i) => i.categories.includes(key));
  if (key === 'wip' && !showWip) {
    console.log(`\x1b[2m${label}: ${items.length} hidden (pass --wip to show)\x1b[0m\n`);
    continue;
  }
  console.log(`\x1b[1m${label} (${items.length})\x1b[0m`);
  for (const i of items) {
    const who = i.waitingOn === 'author' ? i.author : i.waitingFor.join(', ') || 'no reviewers';
    const last = i.lastActivity.by ? `${i.lastActivity.by} ${i.lastActivity.type}` : 'no activity';
    console.log(`  D${i.id}  waiting ${dur(now - i.waitingSince).padStart(4)} on ${who}  · last: ${last} ${dur(now - i.lastActivity.at)} ago`);
    console.log(`         ${i.title}`);
  }
  console.log();
}

console.log('\x1b[1mPer member\x1b[0m');
for (const m of report.members) {
  console.log(`  ${m.username.padEnd(16)} open patches ${m.authored}  reviews owed ${m.reviewsOwed}`);
}
console.log(`\n${report.meta.requests} API requests`);
