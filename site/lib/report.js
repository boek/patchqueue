import { analyze } from './analyze.js';
import { collect, emptyCache } from './collect.js';
import { createConduit } from './conduit.js';

export async function buildReport({ token, config, cache = emptyCache(), budget = Infinity, now = Date.now() }) {
  const conduit = createConduit({ baseUrl: config.phabricatorUrl, token, budget });
  const data = await collect({ conduit, config, cache });
  return { report: analyze(data, config, now), cache: data.cache, changes: data.changes };
}
