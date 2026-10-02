/* Phase 5.2B helpers: shared by runtime parts. No secrets. */
const fs = require('fs');
const path = require('path');
const REPO_ROOT = __dirname;
const DIST = path.join(REPO_ROOT, 'apps/server/dist');
function src(p) { return fs.readFileSync(p, 'utf8'); }
function fresh(rel) { const f = path.join(DIST, rel); delete require.cache[require.resolve(f)]; return require(f); }
function setEnv(v) { const p = {}; for (const k of Object.keys(v)) { p[k] = process.env[k]; if (v[k] === undefined) delete process.env[k]; else process.env[k] = v[k]; } return p; }
function rest(p) { for (const k of Object.keys(p)) { if (p[k] === undefined) delete process.env[k]; else process.env[k] = p[k]; } }
function mf(h) { const calls = []; const f = async (u, i) => { calls.push({ url: u, init: i }); return h(u, i); }; f.calls = calls; return f; }
const ok = (b, s) => ({ ok: true, status: s || 200, json: async () => b });
const er = (s) => ({ ok: false, status: s, json: async () => ({ error: { message: 'x' } }) });
module.exports = { REPO_ROOT, DIST, src, fresh, setEnv, rest, mf, ok, er };
