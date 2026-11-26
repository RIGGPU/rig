// The RIG ledger: credits, outputs, per-second rentals, API keys, receipts and refunds.
// Amounts are micro-credits (1 credit = 1,000,000) and atomic token units, always integers.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import * as evm from './evm.js';
import * as gpu from './provider.js';

export const M = 1e6, CREDIT_PRICE = 0.70, TEST = process.env.RIG_TEST === '1';
export const TREASURY = evm.isAddress(process.env.TREASURY) ? evm.lower(process.env.TREASURY) : '', TOKEN_MINT = evm.isAddress(process.env.TOKEN_ADDRESS) ? evm.lower(process.env.TOKEN_ADDRESS) : '';
const DATA = process.env.DATA_PATH || path.resolve('rig.data.json'), FILES = process.env.FILES_DIR || path.join(path.dirname(DATA), 'rig-files');
let key = null; try { if (process.env.TREASURY_SECRET) key = evm.signer(process.env.TREASURY_SECRET); } catch (e) { console.error('TREASURY_SECRET ignored:', e.message); }
export const treasury = () => TREASURY || key?.address || '';
export const canSign = () => !!key;
export const treasurySend = (to, data, value = 0n) => { if (!key) throw Object.assign(new Error('The treasury cannot sign yet'), { status: 503 }); return evm.send(key, to, data, value); };
const FREE_HOLD = 1000, FREE_IMG = 50, FREE_VID = 2, MIN_BUY = 5, MAX_BUY = 1000, DAY = 86400e3, HOUR = 3600e3;
const sha = (s) => createHash('sha256').update(s).digest('hex'), now = () => Date.now(), day = (t = now()) => new Date(t).toISOString().slice(0, 10);
const E = (status, message) => Object.assign(new Error(message), { status });
const id = (p) => p + randomBytes(9).toString('base64url');

let db = { accounts: {}, paid: {}, outputs: {}, instances: {}, receipts: [], seals: {}, refunds: [], burns: [], sessions: {}, x402: {}, totals: { outputs: 0, gpuSeconds: 0, spent: 0, bought: 0 } };
try { db = { ...db, ...JSON.parse(fs.readFileSync(DATA, 'utf8')) }; } catch { /* first run */ }
fs.mkdirSync(FILES, { recursive: true });
let timer = null; const save = () => { if (timer) return; timer = setTimeout(() => { timer = null; try { fs.writeFileSync(DATA + '.tmp', JSON.stringify(db)); fs.renameSync(DATA + '.tmp', DATA); } catch (e) { console.error('save failed:', e.message); } }, 400); };
export const flush = () => { clearTimeout(timer); timer = null; fs.writeFileSync(DATA, JSON.stringify(db)); };

const acct = (w) => (db.accounts[w] ||= { lots: [], keys: [], ssh: [], lines: [], free: { day: '', img: 0, vid: 0 }, since: now() });
const line = (a, l) => { a.lines.unshift({ ts: now(), ...l }); if (a.lines.length > 400) a.lines.length = 400; };
export const balance = (w) => (db.accounts[w]?.lots || []).reduce((s, l) => s + l.left, 0);

// ---------- sign-in: the wallet signs one message ----------
const nonces = new Map();
export function nonce(w) { if (!evm.isAddress(w)) throw E(400, 'That is not a wallet address'); w = evm.lower(w); const n = randomBytes(12).toString('hex'), message = `RIG sign-in\nWallet: ${w}\nNonce: ${n}\nSigning costs no gas and moves no funds.`; nonces.set(w, { message, exp: now() + 300e3 }); return { message }; }
export function signIn(w, signature) {
  w = evm.lower(w || ''); const n = nonces.get(w); if (!n || n.exp < now()) throw E(400, 'Ask for a new sign-in message');
  let who; try { who = evm.recoverPersonal(n.message, signature); } catch { throw E(400, 'Bad signature'); }
  if (who !== w) throw E(401, 'That signature does not match the wallet');
  nonces.delete(w); acct(w); const token = 'rgs_' + randomBytes(24).toString('hex'); db.sessions[sha(token)] = { wallet: w, exp: now() + 7 * DAY }; save(); return { token, wallet: w };
}
// -> { wallet, key|null }. A session acts as the wallet; an API key acts for it inside its cap.
export function auth(bearer) {
  if (!bearer) throw E(401, 'Sign in, or send an API key');
  if (bearer.startsWith('rgs_')) { const s = db.sessions[sha(bearer)]; if (!s || s.exp < now()) throw E(401, 'Sign in again'); return { wallet: s.wallet, key: null }; }
  if (bearer.startsWith('rgk_')) { const h = sha(bearer); for (const [w, a] of Object.entries(db.accounts)) { const k = a.keys.find((x) => x.hash === h); if (k) { if (k.stopped) throw E(403, 'This key is stopped'); return { wallet: w, key: k }; } } }
  throw E(401, 'Unknown key');
}

// ---------- credits ----------
const tokenPx = { samples: [], dec: null };
async function tokenQuote() {            // the lower of spot and the 30-minute average, as the price a payment in the token gets
  if (!TOKEN_MINT) throw E(400, 'The token is not live yet');
  const spot = TEST ? 0.002 : await evm.usdPrice(TOKEN_MINT); tokenPx.samples.push([now(), spot]); tokenPx.samples = tokenPx.samples.filter(([t]) => now() - t < 1800e3);
  if (tokenPx.dec === null) tokenPx.dec = TEST ? 18 : await evm.decimalsOf(TOKEN_MINT);
  const avg = tokenPx.samples.reduce((s, [, p]) => s + p, 0) / tokenPx.samples.length; return { usd: Math.min(spot, avg), decimals: tokenPx.dec };
}
if (TOKEN_MINT && !TEST) setInterval(() => tokenQuote().catch(() => {}), 60e3).unref();
const ethUsd = async () => (TEST ? 2000 : evm.usdPrice(evm.WETH));
const creditsFor = (usd) => Math.floor(usd / CREDIT_PRICE * M);          // cut down, never rounded up

// What the wallet has to send for `amount` dollars of the chosen asset, and the pieces its transaction needs.
export async function buyIntent(w, pay, amount) {
  if (!treasury()) throw E(503, 'Deposits are not open yet');
  amount = Number(amount); if (!(amount >= MIN_BUY && amount <= MAX_BUY)) throw E(400, `Pick an amount from ${MIN_BUY} to ${MAX_BUY}`);
  const out = { pay, treasury: treasury(), usd: amount, credits: creditsFor(amount) / M, chainId: evm.CHAIN_ID };
  if (pay === 'eth') { const px = await ethUsd(); return { ...out, wei: String(BigInt(Math.ceil(amount / px * 1e9)) * 10n ** 9n), price: px }; }
  const token = pay === 'usdg' ? evm.USDG : pay === 'token' ? TOKEN_MINT : null; if (!token) throw E(400, 'Pay with usdg, eth or token');
  const q = pay === 'token' ? await tokenQuote() : { usd: 1, decimals: 6 };
  // six decimals of the amount in integers, then scaled, so an 18-decimal token never passes through a float
  const atomic = BigInt(Math.ceil(amount / q.usd * 1e6)) * 10n ** BigInt(q.decimals) / 10n ** 6n;
  return { ...out, token, decimals: q.decimals, atomic: atomic.toString(), data: evm.transferData(treasury(), atomic), price: q.usd, holds: TEST ? atomic.toString() : (await evm.balanceOf(token, w)).toString() };
}
function addLot(w, src, micro, paid, sig, from, note) {
  const a = acct(w), lot = { id: id('lot_'), src, credits: micro, left: micro, paid: String(paid), sig, from: from || null, ts: now(), used: 0, burned: '0' };
  a.lots.push(lot); db.paid[sig] = w; db.totals.bought += micro; line(a, { kind: 'deposit', micro, note, tx: sig }); save(); return lot;
}
// The wallet says "this transaction paid you". The chain decides what it is worth.
export async function confirmBuy(w, pay, sig, testPaid) {
  if (!treasury()) throw E(503, 'Deposits are not open yet');
  if (!evm.isTxHash(sig)) throw E(400, 'Send the transaction hash'); if (db.paid[sig]) throw E(409, 'That payment is already credited');
  const mint = pay === 'usdg' ? evm.USDG : pay === 'token' ? TOKEN_MINT : pay === 'eth' ? null : undefined; if (mint === undefined || (pay === 'token' && !mint)) throw E(400, 'Pay with usdg, eth or token');
  const p = TEST ? { signed: true, atomic: BigInt(testPaid || 0), from: w } : await evm.readPayment(sig, w, treasury(), mint);
  if (!p) throw E(404, 'The chain has not confirmed it yet'); if (p.failed) throw E(400, 'That transaction failed'); if (!p.signed) throw E(403, 'That transaction was not signed by this wallet'); if (!(p.atomic > 0n)) throw E(400, 'It sent nothing to RIG');
  let usd; if (pay === 'usdg') usd = Number(p.atomic) / 1e6; else if (pay === 'eth') usd = Number(p.atomic) / 1e18 * await ethUsd(); else { const q = await tokenQuote(); usd = Number(p.atomic) / 10 ** q.decimals * q.usd; }
  const micro = creditsFor(usd); if (micro < 1) throw E(400, 'Too small to credit');
  const lot = addLot(w, pay, micro, p.atomic, sig, p.from, pay === 'usdg' ? 'USDG' : pay === 'eth' ? 'ETH' : '$RIG');
  return { credits: micro / M, balance: balance(w) / M, lot: lot.id };
}

// Take credits. Lots bought with the token go first (their tokens burn as they are used), then the oldest.
function take(w, micro, key) {
  if (micro <= 0) return [];
  const a = acct(w); if (balance(w) < micro) throw E(402, 'Not enough credits');
  if (key) { const d = day(); if (key.day !== d) { key.day = d; key.spent = 0; } if (key.cap && key.spent + micro > key.cap) throw E(429, 'This key reached its spend cap for today'); key.spent += micro; }
  const took = []; let need = micro;
  for (const lot of [...a.lots].sort((x, y) => (y.src === 'token') - (x.src === 'token') || x.ts - y.ts)) { if (!need) break; const t = Math.min(lot.left, need); if (!t) continue; lot.left -= t; lot.used += t; need -= t; took.push([lot.id, t]); }
  db.totals.spent += micro; return took;
}
function giveBack(w, took, key) { const a = acct(w); let sum = 0; for (const [lotId, t] of took) { const lot = a.lots.find((l) => l.id === lotId); if (lot) { lot.left += t; lot.used -= t; sum += t; } } if (key) key.spent = Math.max(0, (key.spent || 0) - sum); db.totals.spent -= sum; return sum; }

// Unused credits go back to the wallet at the price it paid, each in the asset it paid with.
export async function refund(w) {
  const a = acct(w); if (Object.values(db.instances).some((i) => i.wallet === w && ['starting', 'running'].includes(i.state))) throw E(409, 'End your instance first');
  const items = []; let usd = 0, micro = 0;
  for (const lot of a.lots) { if (!lot.left) continue; const atomic = BigInt(lot.paid) * BigInt(lot.left) / BigInt(lot.credits); items.push({ src: lot.src, atomic: atomic.toString(), to: lot.from }); usd += lot.left / M * CREDIT_PRICE; micro += lot.left; }
  if (usd < 1) throw E(400, 'A refund starts at 1 USDG');
  for (const lot of a.lots) { lot.credits -= lot.left; lot.paid = (BigInt(lot.paid) - BigInt(lot.paid) * BigInt(lot.left) / BigInt(lot.credits + lot.left)).toString(); lot.left = 0; }
  a.lots = a.lots.filter((l) => l.credits > 0);
  const r = { id: id('rf_'), wallet: w, items, micro, ts: now(), state: 'queued', txs: [] }; db.refunds.push(r); line(a, { kind: 'refund', micro: -micro, ref: r.id }); save();
  if (key && !TEST) await payRefund(r).catch((e) => { r.error = e.message; });
  return { id: r.id, credits: micro / M, state: r.state, items };
}
async function payRefund(r) {
  for (const it of r.items) { if (it.done) continue;
    it.done = it.src === 'eth' ? await evm.send(key, r.wallet, '0x', BigInt(it.atomic)) : await evm.send(key, it.src === 'usdg' ? evm.USDG : TOKEN_MINT, evm.transferData(r.wallet, it.atomic));
    r.txs.push(it.done); }
  r.state = 'sent'; save();
}
export function settleRefund(refundId, tx) { const r = db.refunds.find((x) => x.id === refundId); if (!r) throw E(404, 'No such refund'); r.state = 'sent'; if (tx) r.txs.push(tx); save(); return r; }
export const refundQueue = () => db.refunds.filter((r) => r.state === 'queued');

// ---------- receipts: one per output and per rental, sealed by the hour ----------
const leafOf = (r) => sha([r.id, r.wallet, r.kind, r.ref, r.what, r.micro, r.seconds, r.ts].join('|'));
function receipt(w, kind, ref, what, micro, seconds) { const r = { id: id('rc_'), wallet: w, kind, ref, what, micro, seconds, ts: now() }; db.receipts.push(r); return r; }
const pair = (a, b) => sha(a < b ? a + b : b + a);
function tree(leaves) { const levels = [leaves]; while (levels.at(-1).length > 1) { const l = levels.at(-1), n = []; for (let i = 0; i < l.length; i += 2) n.push(i + 1 < l.length ? pair(l[i], l[i + 1]) : l[i]); levels.push(n); } return levels; }
const hourOf = (ts) => Math.floor(ts / HOUR), inHour = (h) => db.receipts.filter((r) => hourOf(r.ts) === h).sort((a, b) => (a.id < b.id ? -1 : 1));
export async function sealHours(upTo = hourOf(now())) {
  const hours = [...new Set(db.receipts.map((r) => hourOf(r.ts)))].filter((h) => h < upTo && !db.seals[h]);
  for (const h of hours) { const rs = inHour(h), root = tree(rs.map(leafOf)).at(-1)[0]; db.seals[h] = { root, count: rs.length, tx: null, ts: now() }; }
  if (key && !TEST) for (const [h, s] of Object.entries(db.seals)) if (!s.tx) { try { s.tx = await evm.send(key, key.address, '0x' + Buffer.from(`rig:receipts:v1:${h}:${s.root}`).toString('hex')); } catch (e) { s.error = e.message; break; } }
  if (hours.length) save(); return hours.length;
}
export function proof(receiptId) {
  const r = db.receipts.find((x) => x.id === receiptId); if (!r) throw E(404, 'No such receipt');
  const h = hourOf(r.ts), seal = db.seals[h] || null, rs = inHour(h), levels = tree(rs.map(leafOf)); let i = rs.findIndex((x) => x.id === r.id); const pathUp = [];
  for (let l = 0; l < levels.length - 1; l++) { const sib = i ^ 1; if (sib < levels[l].length) pathUp.push(levels[l][sib]); i >>= 1; }
  return { receipt: r, leaf: leafOf(r), path: pathUp, root: levels.at(-1)[0], hour: h, sealed: !!seal, tx: seal?.tx || null, fields: 'id|wallet|kind|ref|what|micro|seconds|ts' };
}
export const receiptsOf = (w) => db.receipts.filter((r) => r.wallet === w).slice(-200).reverse().map((r) => ({ ...r, credits: r.micro / M, sealed: !!db.seals[hourOf(r.ts)], tx: db.seals[hourOf(r.ts)]?.tx || null }));

// ---------- $RIG: free outputs for holders, and the burn of what token-bought credits used ----------
const holds = new Map();
async function holder(w) { if (!TOKEN_MINT) return false; const c = holds.get(w); if (c && now() - c.at < 300e3) return c.ok; let ok = false; try { if (TEST) ok = w.endsWith('f00d'); else { const q = await tokenQuote(); ok = (await evm.balanceOf(TOKEN_MINT, w)) >= BigInt(FREE_HOLD) * 10n ** BigInt(q.decimals); } } catch { ok = c?.ok || false; } holds.set(w, { at: now(), ok }); return ok; }
export async function freeLeft(w) { const a = acct(w); if (a.free.day !== day()) a.free = { day: day(), img: 0, vid: 0 }; const ok = await holder(w); return { holder: ok, images: ok ? FREE_IMG - a.free.img : 0, videos: ok ? FREE_VID - a.free.vid : 0 }; }
export async function burnDue() {
  let due = 0n; const lots = Object.values(db.accounts).flatMap((a) => a.lots).filter((l) => l.src === 'token');
  for (const l of lots) { const total = BigInt(l.paid) * BigInt(l.used) / BigInt(l.credits || 1), d = total - BigInt(l.burned); if (d > 0n) due += d; }
  if (due <= 0n) return { atomic: '0' };
  let tx = null; if (key && TOKEN_MINT && !TEST) tx = await evm.send(key, TOKEN_MINT, evm.transferData(evm.DEAD, due));   // sent to the dead address, where nobody holds a key
  if (tx || TEST) { for (const l of lots) l.burned = (BigInt(l.paid) * BigInt(l.used) / BigInt(l.credits || 1)).toString(); db.burns.unshift({ ts: now(), atomic: due.toString(), tx }); db.burns.length = Math.min(db.burns.length, 200); save(); }
  return { atomic: due.toString(), tx };
}

// ---------- outputs ----------
const pub = (o) => ({ id: o.id, model: o.model, kind: o.kind, status: o.state, prompt: o.params.prompt, size: o.params.size, seconds: o.params.seconds || undefined, credits: o.micro / M, free: o.free || undefined, reason: o.reason, created: o.ts, mime: o.mime, file: o.state === 'ready' ? `/api/v1/outputs/${o.id}/file` : undefined });
export async function makeOutput(w, body, { key: k = null, x402 = false } = {}) {
  const m = gpu.model(body?.model); if (!m) throw E(400, 'Unknown model. GET /api/v1/models lists them');
  const { micro, params } = gpu.priceOf(m, body || {}); if (!params.prompt.trim()) throw E(400, 'Write a prompt');
  if (!gpu.connected()) throw E(503, 'The GPU provider is not connected yet');
  const a = acct(w); let free = false;
  if (!x402 && !k && m.kind !== 'voice' && (m.kind === 'image' || params.seconds === 5)) { const f = await freeLeft(w); if (m.kind === 'image' ? f.images > 0 : f.videos > 0) { free = true; a.free[m.kind === 'image' ? 'img' : 'vid']++; } }
  const took = free ? [] : take(w, micro, k);
  const o = { id: id('out_'), wallet: w, model: m.id, kind: m.kind, params, micro: free ? 0 : micro, free, took, key: k?.id || null, x402, state: 'making', ts: now() };
  try { Object.assign(o, await gpu.startOutput(m, params)); } catch (e) { giveBack(w, took, k); if (free) a.free[m.kind === 'image' ? 'img' : 'vid']--; throw e; }
  db.outputs[o.id] = o; if (!free) line(a, { kind: 'output', micro: -micro, ref: o.id, note: m.name }); save(); return pub(o);
}
async function pollOutputs() {
  for (const o of Object.values(db.outputs)) { if (o.state !== 'making') continue; const m = gpu.model(o.model); let r;
    try { r = now() - o.ts > 15 * 60e3 ? { state: 'failed', reason: 'it took too long' } : await gpu.readOutput(m, o); } catch { continue; }
    if (r.state === 'ready') { fs.writeFileSync(path.join(FILES, o.id + '.' + r.ext), r.bytes); o.state = 'ready'; o.mime = r.mime; o.ext = r.ext; o.bytes = r.bytes.length; db.totals.outputs++; if (!o.free) o.receipt = receipt(o.wallet, 'output', o.id, o.model, o.micro, 0).id; save(); }
    else if (r.state === 'failed') { const a = acct(o.wallet), k = a.keys.find((x) => x.id === o.key) || null; o.state = 'failed'; o.reason = r.reason; const back = giveBack(o.wallet, o.took, k); if (o.free) a.free[o.kind === 'image' ? 'img' : 'vid'] = Math.max(0, a.free[o.kind === 'image' ? 'img' : 'vid'] - 1); if (back) line(a, { kind: 'giveback', micro: back, ref: o.id, note: 'failed output' }); o.micro = 0; save(); } }
  // a file is kept for a day
  for (const o of Object.values(db.outputs)) if (now() - o.ts > DAY) { if (o.ext) fs.rm(path.join(FILES, o.id + '.' + o.ext), () => {}); delete db.outputs[o.id]; }
}
export function getOutput(outId, w) { const o = db.outputs[outId]; if (!o || (w && o.wallet !== w) || (!w && !o.x402)) throw E(404, 'No such output'); return pub(o); }
export function outputFile(outId, w, linkOk) { const o = db.outputs[outId]; if (!o || o.state !== 'ready' || !(linkOk || o.x402 || o.wallet === w)) throw E(404, 'No such file'); return { path: path.join(FILES, o.id + '.' + o.ext), mime: o.mime, name: o.id + '.' + o.ext }; }
export const fileLink = (outId) => { const o = db.outputs[outId]; if (!o) return null; o.link ||= randomBytes(12).toString('hex'); save(); return `/api/v1/outputs/${o.id}/file?k=${o.link}`; };
export const linkOk = (outId, k) => !!k && db.outputs[outId]?.link === k;
export const outputsOf = (w) => Object.values(db.outputs).filter((o) => o.wallet === w).sort((a, b) => b.ts - a.ts).map(pub);
export async function waitOutput(outId, ms) { const end = now() + ms; for (;;) { const o = db.outputs[outId]; if (!o || o.state !== 'making' || now() > end) return o ? pub(o) : null; await new Promise((ok) => setTimeout(ok, TEST ? 60 : 800)); } }

// ---------- SSH keys ----------
export function addSsh(w, name, line0) { const a = acct(w), k = String(line0 || '').trim(); if (!/^(ssh|ecdsa|sk)-[^\s]+ [A-Za-z0-9+/=]{40,}([ \t][^\n\r]*)?$/.test(k)) throw E(400, 'Paste the one line of a .pub file'); if (a.ssh.length >= 10) throw E(400, 'A wallet keeps up to 10 keys'); if (a.ssh.some((s) => s.key === k)) throw E(409, 'That key is already added'); const s = { id: id('ssh_'), name: String(name || 'key').slice(0, 40), key: k, ts: now() }; a.ssh.push(s); save(); return s; }
export const sshOf = (w) => acct(w).ssh;
export function dropSsh(w, sid) { const a = acct(w), n = a.ssh.length; a.ssh = a.ssh.filter((s) => s.id !== sid); if (a.ssh.length === n) throw E(404, 'No such key'); save(); }

// ---------- rentals: a whole GPU, metered by the second ----------
const live = (i) => ['starting', 'running'].includes(i.state);
const ipub = (i) => ({ id: i.id, gpu: i.gpu, vram: i.vram, status: i.state, rate: i.rate / M, created: i.ts, started: i.runAt || null, ended: i.endAt || null, seconds: i.seconds, credits: i.micro / M, loadout: (({ id, name, app, port }) => ({ id, name, app, port }))(gpu.loadout(i.loadout)), ssh: i.state === 'running' ? i.ssh : undefined, tunnel: i.state === 'running' ? i.jupyter || undefined : undefined, jupyter: i.state === 'running' ? i.jupyter || undefined : undefined, reason: i.reason });
export async function rent(w, body, k = null) {
  const a = acct(w), lo = gpu.loadout(body?.loadout); if (!lo) throw E(400, 'Unknown loadout. GET /api/v1/loadouts lists them'); if (!a.ssh.length) throw E(400, 'Add an SSH key first'); if (Object.values(db.instances).some((i) => i.wallet === w && live(i))) throw E(409, 'A wallet runs one instance at a time');
  const list = await gpu.listGpus(), want = !body?.gpu || body.gpu === 'auto' ? gpu.cheapest(list, +body?.vram || 0) : list.find((g) => g.id === body.gpu || g.name.toLowerCase() === String(body.gpu).toLowerCase());
  if (!want) throw E(404, 'No GPU fits that'); if (!want.available) throw E(409, 'That GPU is busy right now. A busy GPU charges nothing');
  const rate = Math.round(want.listed * M); if (balance(w) < rate / 6) throw E(402, 'Your credits must pay for at least 10 minutes of this GPU');
  if (!gpu.connected()) throw E(503, 'The GPU provider is not connected yet');
  const i = { id: id('ins_'), wallet: w, gpu: want.name, gpuId: want.id, cloud: want.cloud, vram: want.vram, rate, state: 'starting', ts: now(), seconds: 0, micro: 0, took: [], key: k?.id || null, tries: 1, loadout: lo.id };
  Object.assign(i, await gpu.startPod(want, i.id, a.ssh.map((s) => s.key), lo)); db.instances[i.id] = i; save(); return ipub(i);
}
async function endInstance(i, reason) {
  if (!live(i)) return; const wasRunning = i.state === 'running'; i.state = reason === 'failed' ? 'failed' : 'ended'; i.endAt = now(); i.reason = reason;
  try { await gpu.endPod(i.pod); } catch (e) { i.endError = e.message; }
  if (wasRunning && i.micro > 0) { i.receipt = receipt(i.wallet, 'rental', i.id, i.gpu, i.micro, i.seconds).id; db.totals.gpuSeconds += i.seconds; }
  save();
}
export async function endRental(w, insId) { const i = db.instances[insId]; if (!i || i.wallet !== w) throw E(404, 'No such instance'); await endInstance(i, 'ended by you'); return ipub(i); }
async function tick() {
  for (const i of Object.values(db.instances)) {
    if (!live(i)) { if (now() - (i.endAt || i.ts) > DAY) delete db.instances[i.id]; continue; }
    const a = acct(i.wallet), k = a.keys.find((x) => x.id === i.key) || null;
    if (i.key && (!k || k.stopped)) { await endInstance(i, 'its key was stopped'); continue; }
    if (i.state === 'starting' || now() - (i.seen || 0) > (TEST ? 250 : 30e3)) {
      let p; try { p = await gpu.readPod(i.pod, gpu.loadout(i.loadout)); } catch { continue; } i.seen = now();
      if (p.state === 'running' && i.state === 'starting') { i.state = 'running'; i.runAt = i.billed = now(); i.ssh = p.ssh; i.jupyter = p.jupyter; save(); }   // billing starts the second SSH is ready
      else if (p.state === 'failed' || (p.state === 'ended' && i.state === 'starting') || (i.state === 'starting' && now() - i.ts > 15 * 60e3)) {
        // it never started: move to the next cheapest GPU that fits once, otherwise stop. Nothing was billed.
        try { await gpu.endPod(i.pod); } catch { /* already gone */ }
        const next = i.tries < 2 ? (await gpu.listGpus().catch(() => [])).find((g) => g.available && g.vram >= i.vram && g.id !== i.gpuId && Math.round(g.listed * M) / 6 <= balance(i.wallet)) : null;
        if (next) { try { Object.assign(i, await gpu.startPod(next, i.id, a.ssh.map((s) => s.key), gpu.loadout(i.loadout)), { gpu: next.name, gpuId: next.id, vram: next.vram, rate: Math.round(next.listed * M), ts: now(), tries: 2, moved: true }); save(); continue; } catch { /* fall through */ } }
        i.state = 'failed'; i.endAt = now(); i.reason = 'the GPU never started, so nothing was charged'; save(); continue; }
      else if (p.state === 'ended' && i.state === 'running') { await endInstance(i, 'the GPU stopped'); continue; }
    }
    if (i.state === 'running') { const secs = Math.floor((now() - i.billed) / 1000); if (secs < 1) continue; const micro = Math.ceil(i.rate * secs / 3600);
      try { i.took.push(...take(i.wallet, micro, k)); i.billed += secs * 1000; i.seconds += secs; i.micro += micro; const l = a.lines.find((x) => x.ref === i.id); if (l) l.micro = -i.micro; else line(a, { kind: 'rental', micro: -i.micro, ref: i.id, note: i.gpu }); save(); }
      catch (e) { await endInstance(i, e.status === 429 ? 'its key reached its spend cap' : 'the credits ran out'); } }
  }
}
export const instancesOf = (w) => Object.values(db.instances).filter((i) => i.wallet === w).sort((a, b) => b.ts - a.ts).map(ipub);
export function getInstance(w, insId) { const i = db.instances[insId]; if (!i || i.wallet !== w) throw E(404, 'No such instance'); return ipub(i); }

// ---------- API keys: a name, a spend cap per UTC day, and one switch ----------
const kpub = (k) => ({ id: k.id, name: k.name, cap: k.cap ? k.cap / M : null, stopped: !!k.stopped, spentToday: k.day === day() ? (k.spent || 0) / M : 0, created: k.ts, tail: k.tail });
const capOf = (c) => { if (c === null || c === undefined || c === '') return 0; c = Number(c); if (!(c >= 0.01 && c <= 10000)) throw E(400, 'A cap is from 0.01 to 10,000 credits'); return Math.round(c * M); };
export function makeKey(w, name, cap) { const a = acct(w); if (a.keys.length >= 10) throw E(400, 'A wallet keeps up to 10 keys'); const raw = 'rgk_' + randomBytes(24).toString('hex'), k = { id: id('key_'), name: String(name || 'key').slice(0, 40), hash: sha(raw), tail: raw.slice(-4), cap: capOf(cap), stopped: false, ts: now(), day: day(), spent: 0 }; a.keys.push(k); save(); return { ...kpub(k), key: raw }; }
export const keysOf = (w) => acct(w).keys.map(kpub);
export function patchKey(w, kid, body) { const k = acct(w).keys.find((x) => x.id === kid); if (!k) throw E(404, 'No such key'); if ('cap' in body) k.cap = capOf(body.cap); if ('stopped' in body) k.stopped = !!body.stopped; save(); return kpub(k); }
export function dropKey(w, kid) { const a = acct(w), n = a.keys.length; a.keys = a.keys.filter((k) => k.id !== kid); if (a.keys.length === n) throw E(404, 'No such key'); save(); }

// ---------- x402: a payment that buys the credits its own output spends ----------
export function x402Seen(tx) { return !!db.x402[tx]; }
export function x402Credit(payer, atomic, tx) { if (db.x402[tx]) throw E(409, 'That payment was already used'); db.x402[tx] = now(); const micro = creditsFor(Number(atomic) / 1e6); addLot(evm.lower(payer), 'usdg', micro, atomic, tx, null, 'x402'); return micro; }
export const x402Price = (micro) => Math.ceil(micro * CREDIT_PRICE);     // atomic USDG for this many micro-credits

// ---------- reads ----------
export function overview(w) {
  const a = acct(w), days = {}; for (let d = 13; d >= 0; d--) days[day(now() - d * DAY)] = 0;
  for (const l of a.lines) if (l.micro < 0 && l.kind !== 'refund' && day(l.ts) in days) days[day(l.ts)] += -l.micro / M;
  return { wallet: w, credits: balance(w) / M, creditPrice: CREDIT_PRICE, spend: Object.entries(days).map(([d, c]) => ({ day: d, credits: +c.toFixed(6) })), spentToday: +(days[day()] || 0).toFixed(6), instances: instancesOf(w).filter((i) => ['starting', 'running'].includes(i.status)), history: a.lines.slice(0, 60).map((l) => ({ ...l, credits: l.micro / M, micro: undefined })), lots: a.lots.map((l) => ({ src: l.src, credits: l.credits / M, left: l.left / M, ts: l.ts })) };
}
export function spendOf(w, n = 7) { const o = overview(w); return { credits: o.credits, spentToday: o.spentToday, days: o.spend.slice(-Math.max(1, Math.min(14, n))) }; }
export const stats = () => ({ outputs: db.totals.outputs, gpuSeconds: db.totals.gpuSeconds, creditsSpent: +(db.totals.spent / M).toFixed(2), sealedHours: Object.keys(db.seals).length, receipts: db.receipts.length, burns: db.burns.slice(0, 20), wallets: Object.keys(db.accounts).length });
export const seals = () => Object.entries(db.seals).sort((a, b) => b[0] - a[0]).slice(0, 48).map(([h, s]) => ({ hour: +h, at: new Date(h * HOUR).toISOString(), ...s }));

const every = (ms, f) => setInterval(() => f().catch((e) => console.error(f.name, e.message)), ms).unref();
every(TEST ? 80 : 1500, pollOutputs); every(TEST ? 100 : 5000, tick); every(TEST ? 3600e3 : 60e3, () => sealHours()); every(HOUR, burnDue);
export const _test = { db: () => db, tick, pollOutputs, hourOf };
