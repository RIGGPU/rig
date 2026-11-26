// RIG: the onchain GPU cloud on Robinhood Chain. One process, no dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as E from './engine.js';
import * as gpu from './provider.js';
import * as evm from './evm.js';

const PORT = +process.env.PORT || 8322, ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client');
const okUrl = (u) => (/^https:\/\/[^\s"'<>]+$/.test(u || '') ? u : '');
const SITE = { x: okUrl(process.env.X_URL), gh: okUrl(process.env.GH_URL) || 'https://github.com/RIGGPU/rig', origin: okUrl(process.env.SITE_URL) };
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const err = (status, message) => Object.assign(new Error(message), { status });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64'), unb64 = (s) => JSON.parse(Buffer.from(String(s), 'base64').toString('utf8'));

// ---------- x402 (v2, exact, USDG on Robinhood Chain) ----------
// The agent signs an EIP-3009 transfer of USDG to the treasury. RIG checks the signature itself, then the treasury
// submits it and pays the gas, so the agent needs no ETH. One authorization settles once: the token refuses its nonce twice.
const DOMAIN = evm.domainSeparator('Global Dollar', '1', evm.USDG), used = new Set();
async function settle(auth, signature) {
  if (E.TEST) return '0x' + createHash('sha256').update(auth.from + auth.nonce).digest('hex');
  const tx = await E.treasurySend(evm.USDG, evm.settleData(auth, signature));
  for (let i = 0; i < 40; i++) { const rc = await evm.rpc('eth_getTransactionReceipt', [tx]).catch(() => null); if (rc) { if (rc.status !== '0x1') throw err(402, 'The payment was refused by the token'); return tx; } await new Promise((ok) => setTimeout(ok, 700)); }
  throw err(504, 'The payment is still settling. Send the request again in a moment');
}
async function payPerRequest(req, res, body, url) {
  const m = gpu.model(body?.model); if (!m) throw err(400, 'Unknown model. GET /api/v1/models lists them');
  if (!E.treasury() || !(E.canSign() || E.TEST)) throw err(503, 'x402 payments are not open yet');
  const { micro } = gpu.priceOf(m, body), need = { scheme: 'exact', network: evm.NETWORK, amount: String(E.x402Price(micro)), asset: evm.USDG, payTo: E.treasury(), maxTimeoutSeconds: 120, extra: { name: 'Global Dollar', version: '1' } };
  const resource = { url: (SITE.origin || 'http://' + req.headers.host) + url.pathname, description: `One ${m.kind} output from ${m.name}`, mimeType: 'application/json' };
  const ask = (why) => { const p = { x402Version: 2, error: why, resource, accepts: [need] }; res.writeHead(402, { 'content-type': 'application/json', 'payment-required': b64(p) }); res.end(JSON.stringify(p)); };
  const header = req.headers['payment-signature']; if (!header) return ask('PAYMENT-SIGNATURE header is required');
  let pay; try { pay = unb64(header); } catch { return ask('PAYMENT-SIGNATURE is not base64 JSON'); }
  const acc = pay.accepted || {}, au = pay.payload?.authorization || {}, sig = pay.payload?.signature, now = Math.floor(Date.now() / 1000);
  if (pay.x402Version !== 2 || acc.scheme !== 'exact' || acc.network !== need.network || acc.amount !== need.amount || evm.lower(acc.asset || '') !== need.asset || evm.lower(acc.payTo || '') !== need.payTo) return ask('The payment does not match the price');
  if (!evm.isAddress(au.from) || evm.lower(au.to || '') !== need.payTo || String(au.value) !== need.amount || !/^0x[0-9a-fA-F]{64}$/.test(au.nonce || '')) return ask('The authorization does not match the price');
  if (!(+au.validAfter <= now && +au.validBefore > now + 5)) return ask('The authorization is not valid at this time');
  const once = evm.lower(au.from) + au.nonce.toLowerCase(); if (used.has(once)) return ask('That payment was already used');
  let signer; try { signer = E.TEST && sig === 'test' ? evm.lower(au.from) : evm.recover(evm.authHash(DOMAIN, au), sig); } catch { return ask('The signature is not valid'); }
  if (signer !== evm.lower(au.from)) return ask('The signature does not match the payer');
  used.add(once); let tx; try { tx = await settle(au, sig); } catch (e) { used.delete(once); if (e.status === 402) return ask(e.message); throw e; }
  if (E.x402Seen(tx)) return ask('That payment was already used');
  const payer = evm.lower(au.from), done = { success: true, transaction: tx, network: evm.NETWORK, payer }; E.x402Credit(payer, need.amount, tx);
  const made = await E.makeOutput(payer, body, { x402: true }), out = await E.waitOutput(made.id, E.TEST ? 2500 : 20000);
  res.writeHead(out.status === 'making' ? 202 : 200, { 'content-type': 'application/json', 'payment-response': b64(done) }); res.end(JSON.stringify(out));
}

// ---------- MCP: the same API as tools, over Streamable HTTP ----------
const T = (name, description, properties = {}, required = []) => ({ name, description, inputSchema: { type: 'object', properties, required } });
const TOOLS = [
  T('get_balance', 'Your balance of RIG credits, and what you spent today (UTC).'),
  T('list_models', 'The models that make images, video and voice, with the price of each in credits.'),
  T('make_output', 'Makes an image, a video or a voice with a model, paid with your credits at its listed price, and waits for it.', { model: { type: 'string' }, prompt: { type: 'string' }, size: { type: 'string', enum: ['square', 'wide', 'tall'] }, seconds: { type: 'number' } }, ['model', 'prompt']),
  T('get_output', 'One output: making, ready with a link to its file, or failed with its credits back.', { id: { type: 'string' } }, ['id']),
  T('list_outputs', 'Your outputs of the last 24 hours, newest first.'),
  T('list_gpus', 'The NVIDIA GPUs open to rent now, with their memory and their rate in credits an hour.'),
  T('rent_gpu', 'Rents an instance with an NVIDIA GPU, SSH and Jupyter, paid by the second with your credits until it is ended. gpu is a name, or "auto" with vram for the cheapest that fits.', { gpu: { type: 'string' }, vram: { type: 'number' } }),
  T('list_instances', 'Your instances that run, and those that ended in the last 24 hours.'),
  T('get_instance', 'One instance: its status, how to reach it over SSH once it is ready, and what it cost so far.', { id: { type: 'string' } }, ['id']),
  T('end_instance', 'Ends an instance. Its credits stop at that second. An ended instance never starts again.', { id: { type: 'string' } }, ['id']),
  T('list_ssh_keys', 'The public SSH keys that a new instance takes.'),
  T('add_ssh_key', 'Adds a public SSH key, which every new instance takes.', { name: { type: 'string' }, key: { type: 'string' } }, ['key']),
  T('remove_ssh_key', 'Removes a public SSH key, so new instances no longer take it.', { id: { type: 'string' } }, ['id']),
  T('list_receipts', 'The onchain receipts of your outputs and rentals, each with its proof.'),
];
async function callTool(who, name, a, origin) {
  const w = who.wallet, k = who.key, link = (o) => (o.status === 'ready' ? { ...o, file: origin + E.fileLink(o.id) } : o);
  switch (name) {
    case 'get_balance': return E.spendOf(w, 1);
    case 'list_models': return gpu.publicModels();
    case 'make_output': { const o = await E.makeOutput(w, a, { key: k }); return link(await E.waitOutput(o.id, E.TEST ? 2500 : 50000)); }
    case 'get_output': return link(E.getOutput(a.id, w));
    case 'list_outputs': return E.outputsOf(w).map(link);
    case 'list_gpus': return (await gpu.listGpus()).filter((g) => g.available).map(({ name: n, vram, listed }) => ({ name: n, vram, creditsPerHour: listed }));
    case 'rent_gpu': return E.rent(w, a, k);
    case 'list_instances': return E.instancesOf(w);
    case 'get_instance': return E.getInstance(w, a.id);
    case 'end_instance': return E.endRental(w, a.id);
    case 'list_ssh_keys': return E.sshOf(w);
    case 'add_ssh_key': return E.addSsh(w, a.name, a.key);
    case 'remove_ssh_key': E.dropSsh(w, a.id); return { removed: a.id };
    case 'list_receipts': return E.receiptsOf(w).slice(0, 50).map((r) => ({ ...r, proof: origin + `/api/receipts/${r.id}/proof` }));
    default: throw err(404, 'Unknown tool');
  }
}
async function mcp(req, res, body, origin) {
  const who = E.auth(bearer(req)); if (!who.key) throw err(401, 'Connect with an API key');
  const reply = (id, result, error) => ({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) });
  const one = async (m) => {
    if (m.id === undefined) return null;                                    // a notification
    try {
      if (m.method === 'initialize') return reply(m.id, { protocolVersion: m.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'rig', version: '0.1.0' }, instructions: 'RIG rents NVIDIA GPUs and makes images, video and voice, paid in RIG credits on Robinhood Chain.' });
      if (m.method === 'ping') return reply(m.id, {});
      if (m.method === 'tools/list') return reply(m.id, { tools: TOOLS });
      if (m.method === 'tools/call') { try { const out = await callTool(who, m.params?.name, m.params?.arguments || {}, origin), content = [{ type: 'text', text: JSON.stringify(out) }];
          if (out?.status === 'ready' && out.kind === 'image') { const f = E.outputFile(out.id, who.wallet); content.push({ type: 'image', data: fs.readFileSync(f.path).toString('base64'), mimeType: f.mime }); }
          return reply(m.id, { content }); } catch (e) { return reply(m.id, { content: [{ type: 'text', text: e.message }], isError: true }); } }
      return reply(m.id, null, { code: -32601, message: 'Method not found' });
    } catch (e) { return reply(m.id, null, { code: -32000, message: e.message }); }
  };
  const out = Array.isArray(body) ? (await Promise.all(body.map(one))).filter(Boolean) : await one(body);
  if (!out || (Array.isArray(out) && !out.length)) { res.writeHead(202); return res.end(); }
  json(res, 200, out);
}

// ---------- HTTP ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
const HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'" };
const json = (res, status, body, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }); res.end(JSON.stringify(body)); };
const bearer = (req) => { const h = req.headers.authorization || ''; return h.startsWith('Bearer ') ? h.slice(7).trim() : ''; };
const readBody = (req) => new Promise((ok, no) => { let n = 0; const parts = []; req.on('data', (c) => { n += c.length; if (n > 1e6) { no(err(413, 'Too large')); req.destroy(); } else parts.push(c); }); req.on('end', () => { if (!parts.length) return ok({}); try { ok(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { no(err(400, 'Send JSON')); } }); req.on('error', no); });
const hits = new Map(); setInterval(() => hits.clear(), 60e3).unref();
const pages = { '/': 'index.html', '/app': 'app.html', '/docs': 'docs.html' };
function serveStatic(req, res, p) {
  const file = path.join(ROOT, pages[p] || p); if (!file.startsWith(ROOT)) return false;
  let st; try { st = fs.statSync(file); } catch { return false; } if (!st.isFile()) return false;
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': /\.(woff2|png|svg)$/.test(file) ? 'public, max-age=86400' : 'no-cache' });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res); return true;
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x'), p = url.pathname.replace(/\/+$/, '') || '/', mth = req.method, origin = SITE.origin || 'http://' + req.headers.host;
  for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
  if (p === '/healthz') return json(res, 200, { ok: true });
  if (!p.startsWith('/api') && p !== '/mcp') { if ((mth === 'GET' || mth === 'HEAD') && serveStatic(req, res, p)) return; res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' }); return res.end(fs.readFileSync(path.join(ROOT, '404.html'))); }
  const ip = createHash('sha256').update((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '') + 'rig').digest('hex').slice(0, 16), n = (hits.get(ip) || 0) + 1; hits.set(ip, n); if (n > 600) throw err(429, 'Slow down');
  const body = mth === 'GET' || mth === 'HEAD' ? {} : await readBody(req), seg = p.split('/').filter(Boolean);
  const user = () => E.auth(bearer(req)), wallet = () => { const u = user(); if (u.key) throw err(403, 'Only your wallet, signed in, does that'); return u.wallet; };
  if (p === '/mcp') { if (mth !== 'POST') { res.writeHead(405, { allow: 'POST' }); return res.end(); } return mcp(req, res, body, origin); }

  // public
  if (p === '/api/config') return json(res, 200, { treasury: E.treasury(), token: E.TOKEN_MINT, creditPrice: E.CREDIT_PRICE, provider: gpu.connected(), sealing: E.canSign(), network: evm.NETWORK, chainId: evm.CHAIN_ID, usdg: evm.USDG, x402: !!(E.treasury() && (E.canSign() || E.TEST)), x: SITE.x, gh: SITE.gh, test: E.TEST || undefined });
  if (p === '/api/stats') return json(res, 200, E.stats());
  if (p === '/api/seals') return json(res, 200, E.seals());
  if (p === '/api/v1/models') return json(res, 200, { models: gpu.publicModels(), creditPrice: E.CREDIT_PRICE });
  if (p === '/api/v1/gpus') { const list = await gpu.listGpus(); return json(res, 200, { gpus: list.map(({ id, name, vram, listed, available }) => ({ id, name, vram, listed, available })), auto: gpu.cheapest(list, +url.searchParams.get('vram') || 0)?.name || null }); }
  if (seg[1] === 'receipts' && seg[3] === 'proof') return json(res, 200, E.proof(seg[2]));
  if (p === '/api/auth/nonce' && mth === 'POST') return json(res, 200, E.nonce(body.wallet));
  if (p === '/api/auth/verify' && mth === 'POST') return json(res, 200, E.signIn(body.wallet, body.signature));

  // the signed-in wallet only: money and keys
  if (p === '/api/overview') return json(res, 200, { ...E.overview(wallet()), free: await E.freeLeft(wallet()) });
  if (p === '/api/billing/intent' && mth === 'POST') return json(res, 200, await E.buyIntent(wallet(), body.pay, body.amount));
  if (p === '/api/billing/confirm' && mth === 'POST') return json(res, 200, await E.confirmBuy(wallet(), body.pay, body.signature, E.TEST ? body.testPaid : 0));
  if (p === '/api/billing/refund' && mth === 'POST') return json(res, 200, await E.refund(wallet()));
  if (p === '/api/keys' && mth === 'GET') return json(res, 200, { keys: E.keysOf(wallet()) });
  if (p === '/api/keys' && mth === 'POST') return json(res, 201, E.makeKey(wallet(), body.name, body.cap));
  if (seg[1] === 'keys' && seg[2] && mth === 'PATCH') return json(res, 200, E.patchKey(wallet(), seg[2], body));
  if (seg[1] === 'keys' && seg[2] && mth === 'DELETE') { E.dropKey(wallet(), seg[2]); return json(res, 200, { deleted: seg[2] }); }
  if (seg[1] === 'admin') { if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) throw err(404, 'Not found'); if (seg[2] === 'refunds' && mth === 'GET') return json(res, 200, E.refundQueue()); if (seg[2] === 'refunds' && seg[3] && mth === 'POST') return json(res, 200, E.settleRefund(seg[3], body.tx)); if (seg[2] === 'seal' && mth === 'POST') return json(res, 200, { sealed: await E.sealHours(body.all ? Infinity : undefined) }); if (seg[2] === 'burn' && mth === 'POST') return json(res, 200, await E.burnDue()); }

  // the API: a session or an API key
  if (seg[1] === 'v1') {
    const r = seg[2], rid = seg[3], act = seg[4];
    if (r === 'outputs' && !rid && mth === 'POST') { if (!bearer(req)) return payPerRequest(req, res, body, url); const u = user(); return json(res, 201, await E.makeOutput(u.wallet, body, { key: u.key })); }
    if (r === 'outputs' && rid && act === 'file') { const w = bearer(req) ? user().wallet : null, f = E.outputFile(rid, w, E.linkOk(rid, url.searchParams.get('k'))); res.writeHead(200, { 'content-type': f.mime, 'content-disposition': `inline; filename="${f.name}"`, 'cache-control': 'private, max-age=3600' }); return fs.createReadStream(f.path).pipe(res); }
    if (r === 'outputs' && rid && mth === 'GET') { const o = E.getOutput(rid, bearer(req) ? user().wallet : null); if (o.status === 'ready' && url.searchParams.get('inline') !== '0') { const f = E.outputFile(rid, null, true); if (fs.statSync(f.path).size < 4e6) o.base64 = fs.readFileSync(f.path).toString('base64'); } return json(res, 200, o); }
    const u = user(), w = u.wallet;
    if (r === 'credits') return json(res, 200, E.spendOf(w, +url.searchParams.get('days') || 7));
    if (r === 'outputs' && mth === 'GET') return json(res, 200, { outputs: E.outputsOf(w) });
    if (r === 'instances' && !rid && mth === 'POST') return json(res, 201, await E.rent(w, body, u.key));
    if (r === 'instances' && !rid) return json(res, 200, { instances: E.instancesOf(w) });
    if (r === 'instances' && act === 'terminate' && mth === 'POST') return json(res, 200, await E.endRental(w, rid));
    if (r === 'instances' && rid) return json(res, 200, E.getInstance(w, rid));
    if (r === 'ssh-keys' && !rid && mth === 'POST') return json(res, 201, E.addSsh(w, body.name, body.key));
    if (r === 'ssh-keys' && !rid) return json(res, 200, { keys: E.sshOf(w) });
    if (r === 'ssh-keys' && rid && mth === 'DELETE') { E.dropSsh(w, rid); return json(res, 200, { deleted: rid }); }
    if (r === 'receipts') return json(res, 200, { receipts: E.receiptsOf(w) });
  }
  throw err(404, 'Not found');
}

const server = http.createServer((req, res) => { route(req, res).catch((e) => { const status = e.status >= 400 && e.status < 600 ? e.status : 500; if (status === 500) console.error(req.method, req.url, e); if (!res.headersSent) json(res, status, { error: status === 500 ? 'Something went wrong on our side' : e.message }); else res.end(); }); });
process.on('uncaughtException', (e) => console.error('uncaught', e)); process.on('unhandledRejection', (e) => console.error('unhandled', e));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { try { E.flush(); } catch { /* nothing to save */ } process.exit(0); });
server.listen(PORT, () => console.log(`RIG on :${PORT} · provider ${gpu.connected() ? 'connected' : 'not connected'} · treasury ${E.treasury() || 'not set'}`));
