// End-to-end checks against a real server process, with the provider stand-in (RIG_TEST=1). node test/run.js
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import * as evm from '../server/evm.js';

const PORT = 8323, B = 'http://127.0.0.1:' + PORT, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-test-'));
const TOKEN = '0x00000000000000000000000000000000000070ce', TREASURY = '0x000000000000000000000000000000000000beef', SSH = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILXGDN/SclOozk1xsDztpmhGiKkkrfQB9SKoO8dSIQQZ me@example.com';
const srv = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT, RIG_TEST: '1', DATA_PATH: path.join(dir, 'd.json'), TREASURY, TOKEN_ADDRESS: TOKEN, ADMIN_KEY: 'adm' }, stdio: ['ignore', 'pipe', 'inherit'] });
let pass = 0, fail = 0; const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log('  ok  ', name); } else { fail++; console.log('  FAIL', name, extra); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (p, { method, body, token, headers } = {}) => { const r = await fetch(B + p, { method: method || (body ? 'POST' : 'GET'), headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, j, h: r.headers }; };
function wallet() { const k = evm.signer('0x' + randomBytes(32).toString('hex')); return { address: k.address, sign: (m) => k.signPersonal(m), key: k }; }
async function login(w) { const n = await call('/api/auth/nonce', { body: { wallet: w.address } }); const v = await call('/api/auth/verify', { body: { wallet: w.address, signature: w.sign(n.j.message) } }); return v.j.token; }
const sigOf = (s) => '0x' + createHash('sha256').update(s).digest('hex');
const until = async (f, ms = 6000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v || Date.now() > end) return v; await sleep(80); } };
const admin = { 'x-admin-key': 'adm' }, sha = (s) => createHash('sha256').update(s).digest('hex');

try {
  await until(async () => { try { return (await fetch(B + '/healthz')).ok; } catch { return false; } }, 8000);
  console.log('pages and public data');
  for (const p of ['/', '/app', '/docs', '/rig.css']) ok('GET ' + p, (await fetch(B + p)).status === 200);
  ok('unknown page is 404', (await fetch(B + '/nope')).status === 404);
  const cfg = (await call('/api/config')).j; ok('config has treasury, token and price', !!cfg.treasury && cfg.token === TOKEN && cfg.creditPrice === 0.7);
  const models = (await call('/api/v1/models')).j.models; ok('13 models listed with prices', models.length === 13 && models.every((m) => m.listed > 0));
  const gpus = (await call('/api/v1/gpus?vram=40')).j; ok('GPUs listed, cheapest first', gpus.gpus.length >= 6 && gpus.gpus[0].listed <= gpus.gpus[1].listed);
  ok('vram/auto picks the cheapest GPU with 40 GB', gpus.auto === 'L40S', gpus.auto);
  ok('security headers', ((await fetch(B + '/')).headers.get('content-security-policy') || '').includes("script-src 'self'"));

  console.log('sign-in');
  const A = wallet(), tA = await login(A); ok('wallet signs in', /^rgs_/.test(tA));
  const bad = wallet(), nb = await call('/api/auth/nonce', { body: { wallet: bad.address } });
  ok('a signature from another wallet is refused', (await call('/api/auth/verify', { body: { wallet: bad.address, signature: A.sign(nb.j.message) } })).status === 401);
  ok('no token is 401', (await call('/api/overview')).status === 401);

  console.log('credits');
  const it = (await call('/api/billing/intent', { body: { pay: 'usdg', amount: 5 }, token: tA })).j;
  ok('5 USDG buys 7.14 credits, cut down', Math.abs(it.credits - 7.142857) < 1e-6 && it.atomic === '5000000', JSON.stringify(it));
  ok('an amount under 5 is refused', (await call('/api/billing/intent', { body: { pay: 'usdg', amount: 2 }, token: tA })).status === 400);
  const c1 = await call('/api/billing/confirm', { body: { pay: 'usdg', signature: sigOf('a1'), testPaid: '5000000' }, token: tA });
  ok('deposit credited', c1.status === 200 && Math.abs(c1.j.balance - 7.142857) < 1e-6, JSON.stringify(c1.j));
  ok('the same payment is not credited twice', (await call('/api/billing/confirm', { body: { pay: 'usdg', signature: sigOf('a1'), testPaid: '5000000' }, token: tA })).status === 409);
  const cs = await call('/api/billing/confirm', { body: { pay: 'eth', signature: sigOf('a2'), testPaid: '10000000000000000' }, token: tA });
  ok('0.01 ETH at $2,000 buys 28.57 credits', Math.abs(cs.j.credits - 28.571428) < 1e-5, JSON.stringify(cs.j));

  console.log('outputs');
  const o1 = await call('/api/v1/outputs', { body: { model: 'flux-schnell', prompt: 'a GPU on a marble table' }, token: tA });
  ok('output starts as making', o1.status === 201 && o1.j.status === 'making' && Math.abs(o1.j.credits - 0.004195) < 2e-6, JSON.stringify(o1.j));
  const r1 = await until(async () => { const o = (await call('/api/v1/outputs/' + o1.j.id, { token: tA })).j; return o.status === 'ready' ? o : null; });
  ok('output becomes ready with its file in base64', !!r1?.base64 && r1.mime === 'image/png');
  const f1 = await fetch(B + r1.file, { headers: { authorization: 'Bearer ' + tA } });
  ok('the file is a real PNG', f1.status === 200 && Buffer.from(await f1.arrayBuffer()).subarray(1, 4).toString() === 'PNG');
  ok('the file is closed to others', (await fetch(B + r1.file)).status === 404);
  const before = (await call('/api/v1/credits', { token: tA })).j.credits;
  const o2 = await call('/api/v1/outputs', { body: { model: 'z-image-turbo', prompt: 'FAIL this one' }, token: tA });
  const r2 = await until(async () => { const o = (await call('/api/v1/outputs/' + o2.j.id, { token: tA })).j; return o.status === 'failed' ? o : null; });
  ok('a failed output gives its credits back', !!r2 && Math.abs((await call('/api/v1/credits', { token: tA })).j.credits - before) < 1e-9);
  const v1 = await call('/api/v1/outputs', { body: { model: 'pruna-video', prompt: 'clouds', seconds: 10 }, token: tA });
  ok('a 10 second video costs twice the listed price', Math.abs(v1.j.credits - 0.30) < 1e-9, JSON.stringify(v1.j));
  ok('unknown model is 400', (await call('/api/v1/outputs', { body: { model: 'nope', prompt: 'x' }, token: tA })).status === 400);
  const poor = wallet(), tP = await login(poor);
  ok('no credits is 402', (await call('/api/v1/outputs', { body: { model: 'flux-schnell', prompt: 'x' }, token: tP })).status === 402);
  ok('a wallet without the token has no free outputs', (await call('/api/overview', { token: tP })).j.free.images === 0);

  console.log('API keys');
  const k1 = await call('/api/keys', { body: { name: 'agent', cap: 0.01 }, token: tA });
  ok('key is shown once', k1.status === 201 && /^rgk_/.test(k1.j.key) && k1.j.cap === 0.01);
  const key = k1.j.key; ok('listing hides the key', !JSON.stringify((await call('/api/keys', { token: tA })).j).includes(key));
  ok('a key reads credits', (await call('/api/v1/credits', { token: key })).status === 200);
  ok('a key cannot refund', (await call('/api/billing/refund', { method: 'POST', token: key })).status === 403);
  ok('a key cannot make keys', (await call('/api/keys', { body: { name: 'x' }, token: key })).status === 403);
  ok('a key spends under its cap', (await call('/api/v1/outputs', { body: { model: 'flux-schnell', prompt: 'one' }, token: key })).status === 201);
  ok('a key past its cap is 429', (await call('/api/v1/outputs', { body: { model: 'seedream-4', prompt: 'two' }, token: key })).status === 429);
  await call('/api/keys/' + k1.j.id, { method: 'PATCH', body: { stopped: true }, token: tA });
  ok('a stopped key is 403', (await call('/api/v1/credits', { token: key })).status === 403);
  await call('/api/keys/' + k1.j.id, { method: 'PATCH', body: { stopped: false, cap: null }, token: tA });
  ok('started again with no cap', (await call('/api/v1/outputs', { body: { model: 'seedream-4', prompt: 'two' }, token: key })).status === 201);
  ok('an unknown key is 401', (await call('/api/v1/credits', { token: 'rgk_' + '0'.repeat(48) })).status === 401);

  console.log('GPU rental');
  ok('renting needs an SSH key', (await call('/api/v1/instances', { body: { gpu: 'auto' }, token: tA })).status === 400);
  ok('a bad SSH key is refused', (await call('/api/v1/ssh-keys', { body: { name: 'x', key: 'not a key' }, token: tA })).status === 400);
  ok('SSH key added', (await call('/api/v1/ssh-keys', { body: { name: 'laptop', key: SSH }, token: tA })).status === 201);
  const los = (await call('/api/v1/loadouts')).j.loadouts || [];
  ok('four loadouts are listed with no key', los.length === 4 && los[0].id === 'pytorch' && los.some((l) => l.id === 'comfyui' && l.port === 8188));
  ok('an unknown loadout is refused', (await call('/api/v1/instances', { body: { gpu: 'auto', loadout: 'nope' }, token: tA })).status === 400);
  ok('a busy GPU is refused and charges nothing', (await call('/api/v1/instances', { body: { gpu: 'B200' }, token: tA })).status === 409);
  const i1 = await call('/api/v1/instances', { body: { gpu: 'auto', vram: 24, loadout: 'comfyui' }, token: tA });
  ok('auto rents the cheapest GPU with 24 GB', i1.status === 201 && i1.j.gpu === 'RTX 3090' && i1.j.status === 'starting', JSON.stringify(i1.j));
  ok('one instance at a time', (await call('/api/v1/instances', { body: { gpu: 'auto' }, token: tA })).status === 409);
  ok('refund waits while an instance runs', (await call('/api/billing/refund', { method: 'POST', token: tA })).status === 409);
  const run = await until(async () => { const i = (await call('/api/v1/instances/' + i1.j.id, { token: tA })).j; return i.status === 'running' ? i : null; });
  ok('instance runs with an SSH command', /^ssh root@/.test(run?.ssh || ''));
  ok('the instance boots its loadout and tunnels its port', run?.loadout?.id === 'comfyui' && /-L 8188:localhost:8188/.test(run?.tunnel || ''), JSON.stringify(run).slice(0, 300));
  await sleep(2300); const mid = (await call('/api/v1/instances/' + i1.j.id, { token: tA })).j;
  ok('billed by the second at its rate', mid.seconds >= 2 && mid.credits > 0 && mid.credits <= mid.rate * (mid.seconds + 3) / 3600, JSON.stringify(mid));
  const end = await call('/api/v1/instances/' + i1.j.id + '/terminate', { method: 'POST', token: tA }); ok('instance ends', end.j.status === 'ended'); await sleep(1300);
  ok('its credits stop at that second', (await call('/api/v1/instances/' + i1.j.id, { token: tA })).j.credits === end.j.credits);
  ok('a fuse under 5 minutes is refused outside tests, and a wrong one always', (await call('/api/v1/instances', { body: { gpu: 'auto', fuse: -3 }, token: tA })).status === 400);
  const iF = await call('/api/v1/instances', { body: { gpu: 'auto', fuse: 0.04 }, token: tA });
  const blown = await until(async () => { const i = (await call('/api/v1/instances/' + iF.j.id, { token: tA })).j; return i.status === 'ended' ? i : null; }, 9000);
  ok('an instance with a fuse ends itself', iF.j.fuse === 0.04 && blown?.reason === 'its fuse ran out' && blown.seconds >= 2 && blown.seconds <= 6, JSON.stringify(blown).slice(0, 240));
  const i2 = await call('/api/v1/instances', { body: { gpu: 'RTX 5090' }, token: tA });
  const moved = await until(async () => { const i = (await call('/api/v1/instances/' + i2.j.id, { token: tA })).j; return i.status === 'running' ? i : null; }, 8000);
  ok('a GPU that fails to start moves to another one', !!moved && moved.gpu !== 'RTX 5090', JSON.stringify(moved));
  await call('/api/v1/instances/' + i2.j.id + '/terminate', { method: 'POST', token: tA });
  await call('/api/v1/ssh-keys', { body: { name: 'k', key: SSH }, token: tP }); await call('/api/billing/confirm', { body: { pay: 'usdg', signature: sigOf('p1'), testPaid: '100000' }, token: tP });
  ok('credits must cover 10 minutes of the GPU', (await call('/api/v1/instances', { body: { gpu: 'H100 SXM' }, token: tP })).status === 402);

  console.log('x402');
  const ask = { model: 'flux-schnell', prompt: 'paid by an agent' }, q = await call('/api/v1/outputs', { body: ask });
  const need = JSON.parse(Buffer.from(q.h.get('payment-required') || 'e30=', 'base64').toString()), acc = need.accepts?.[0] || {};
  ok('no key answers 402 with the price', q.status === 402 && need.x402Version === 2 && acc.network === 'eip155:4663' && acc.asset === cfg.usdg && acc.amount === '2937' && acc.payTo === cfg.treasury && acc.extra.name === 'Global Dollar', JSON.stringify(acc));
  const agent = wallet(), other = wallet(), domain = evm.domainSeparator('Global Dollar', '1', evm.USDG), soon = String(Math.floor(Date.now() / 1000) + 100);
  const payload = (amount, signerKey, over = {}) => { const authorization = { from: agent.address, to: acc.payTo, value: amount, validAfter: '0', validBefore: soon, nonce: '0x' + randomBytes(32).toString('hex'), ...over }; return { h: Buffer.from(JSON.stringify({ x402Version: 2, resource: need.resource, accepted: { ...acc, amount }, payload: { signature: signerKey.signHash(evm.authHash(domain, authorization)).hex, authorization } })).toString('base64') }; };
  const pay402 = (p) => call('/api/v1/outputs', { body: ask, headers: { 'payment-signature': p.h } });
  ok('a payment for another price is 402', (await pay402(payload('1', agent.key))).status === 402);
  ok('a signature from another wallet is 402', (await pay402(payload(acc.amount, other.key))).status === 402);
  ok('an expired authorization is 402', (await pay402(payload(acc.amount, agent.key, { validBefore: '1' }))).status === 402);
  ok('an authorization to another address is 402', (await pay402(payload(acc.amount, agent.key, { to: other.address }))).status === 402);
  const good = payload(acc.amount, agent.key), paid = await pay402(good);
  ok('a signed payment makes the output in the same request', paid.status === 200 && paid.j.status === 'ready' && !!paid.h.get('payment-response'), JSON.stringify(paid.j).slice(0, 200));
  ok('the output reads with no key', (await call('/api/v1/outputs/' + paid.j.id)).j.status === 'ready');
  ok('a payment pays once', (await pay402(good)).status === 402);
  ok('other outputs stay closed with no key', (await call('/api/v1/outputs/' + o1.j.id)).status === 404);

  console.log('MCP');
  const rpc = (method, params, id = 1) => call('/mcp', { body: { jsonrpc: '2.0', id, method, params }, token: key });
  ok('initialize', (await rpc('initialize', { protocolVersion: '2025-06-18' })).j.result.serverInfo.name === 'rig');
  ok('14 tools', (await rpc('tools/list')).j.result.tools.length === 14);
  const mo = await rpc('tools/call', { name: 'make_output', arguments: { model: 'flux-schnell', prompt: 'from an agent' } }), mj = JSON.parse(mo.j.result.content[0].text);
  ok('make_output waits and returns a link and the image', mj.status === 'ready' && mo.j.result.content[1]?.type === 'image' && /\?k=/.test(mj.file), JSON.stringify(mj));
  ok('the link opens with no key', (await fetch(mj.file)).status === 200);
  ok('get_balance', JSON.parse((await rpc('tools/call', { name: 'get_balance', arguments: {} })).j.result.content[0].text).credits > 0);
  ok('a tool error is reported, not thrown', (await rpc('tools/call', { name: 'get_output', arguments: { id: 'nope' } })).j.result.isError === true);
  ok('MCP needs a key', (await call('/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).status === 401);
  ok('a notification answers 202', (await call('/mcp', { body: { jsonrpc: '2.0', method: 'notifications/initialized' }, token: key })).status === 202);

  console.log('receipts');
  const rc = (await call('/api/v1/receipts', { token: tA })).j.receipts;
  ok('outputs and the rental each have a receipt', rc.some((r) => r.kind === 'rental' && r.seconds >= 2) && rc.filter((r) => r.kind === 'output').length >= 3);
  await call('/api/admin/seal', { body: { all: true }, headers: admin });
  const pf = (await call(`/api/receipts/${rc[0].id}/proof`)).j; let h = sha(pf.fields.split('|').map((k) => pf.receipt[k]).join('|'));
  ok('the leaf is the hash of the receipt', h === pf.leaf);
  for (const s of pf.path) h = sha(h < s ? h + s : s + h);
  ok('the proof climbs to the sealed root', h === pf.root && pf.sealed === true, JSON.stringify({ h, root: pf.root }));
  ok('admin routes are hidden without the key', (await call('/api/admin/refunds')).status === 404);

  console.log('token credits, burn and refund');
  const D = wallet(), tD = await login(D);
  const ti = (await call('/api/billing/intent', { body: { pay: 'token', amount: 7 }, token: tD })).j;
  ok('7 dollars of the token buys 10 credits', Math.abs(ti.credits - 10) < 1e-6 && ti.atomic === '3500000000000000000000', JSON.stringify(ti));
  await call('/api/billing/confirm', { body: { pay: 'token', signature: sigOf('d1'), testPaid: ti.atomic }, token: tD });
  await call('/api/billing/confirm', { body: { pay: 'usdg', signature: sigOf('d2'), testPaid: '7000000' }, token: tD });
  const od = await call('/api/v1/outputs', { body: { model: 'vidu-q3', prompt: 'spend the token credits first' }, token: tD });
  await until(async () => (await call('/api/v1/outputs/' + od.j.id, { token: tD })).j.status === 'ready');
  const burn = (await call('/api/admin/burn', { body: {}, headers: admin })).j;
  ok('the token of used credits is due to burn', burn.atomic === '385000000000000000000', JSON.stringify(burn));
  ok('nothing burns twice', (await call('/api/admin/burn', { body: {}, headers: admin })).j.atomic === '0');
  const rf = await call('/api/billing/refund', { method: 'POST', token: tD }), items = Object.fromEntries((rf.j.items || []).map((i) => [i.src, i.atomic]));
  ok('unused credits refund at the price paid, each in its own asset', rf.status === 200 && items.token === '3115000000000000000000' && items.usdg === '7000000', JSON.stringify(rf.j));
  ok('the balance is zero after a refund', (await call('/api/v1/credits', { token: tD })).j.credits === 0);
  ok('a refund under 1 USDG is refused', (await call('/api/billing/refund', { method: 'POST', token: tD })).status === 400);
  ok('the refund waits in the queue for the treasury', (await call('/api/admin/refunds', { headers: admin })).j.length === 1);
} catch (e) { fail++; console.error('crashed:', e); }
srv.kill(); await sleep(200); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
