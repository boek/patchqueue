import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Reads the Conduit token for `baseUrl` from ~/.arcrc (written by `arc install-certificate`
// or `moz-phab`).
export function tokenFromArcrc(baseUrl) {
  const file = path.join(os.homedir(), '.arcrc');
  const hosts = JSON.parse(fs.readFileSync(file, 'utf8')).hosts ?? {};
  const want = baseUrl.replace(/\/+$/, '') + '/api/';
  const token = hosts[want]?.token;
  if (!token) throw new Error(`No token for ${want} in ${file}`);
  return token;
}
