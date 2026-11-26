// Robinhood Chain by hand: keccak-256, secp256k1, wallet signatures, reading payments off the chain, and the
// transactions the treasury signs (a refund, a burn, a settled x402 payment, the calldata that seals an hour of receipts).
import { createHmac } from 'node:crypto';

export const CHAIN_ID = 4663, NETWORK = 'eip155:4663';
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168', WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73', DEAD = '0x000000000000000000000000000000000000dead';
export const hex = (u) => Buffer.from(u).toString('hex'), unhex = (s) => { s = String(s).replace(/^0x/, ''); return Buffer.from(s.length % 2 ? '0' + s : s, 'hex'); };
export const isAddress = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
export const isTxHash = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s);
export const lower = (a) => String(a).toLowerCase();

// ---------- keccak-256 ----------
const M64 = (1n << 64n) - 1n;
const RC = [0x1n, 0x8082n, 0x800000000000808an, 0x8000000080008000n, 0x808bn, 0x80000001n, 0x8000000080008081n, 0x8000000000008009n, 0x8an, 0x88n, 0x80008009n, 0x8000000an, 0x8000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n, 0x800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x80000001n, 0x8000000080008008n];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const rol = (x, n) => (n === 0 ? x : ((x << BigInt(n)) | (x >> BigInt(64 - n))) & M64);
function f1600(s) {
  for (let rnd = 0; rnd < 24; rnd++) {
    const c = []; for (let x = 0; x < 5; x++) c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) { const d = c[(x + 4) % 5] ^ rol(c[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) s[x + y] ^= d; }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + ((2 * x + 3 * y) % 5) * 5] = rol(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) s[x + 5 * y] = b[x + 5 * y] ^ ((~b[((x + 1) % 5) + 5 * y] & M64) & b[((x + 2) % 5) + 5 * y]);
    s[0] ^= RC[rnd];
  }
}
export function keccak(buf) {
  buf = Buffer.from(buf); const rate = 136, p = Buffer.alloc(buf.length + rate - (buf.length % rate)); buf.copy(p); p[buf.length] ^= 0x01; p[p.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < p.length; off += rate) { for (let i = 0; i < rate / 8; i++) s[i] ^= p.readBigUInt64LE(off + i * 8); f1600(s); }
  const out = Buffer.alloc(32); for (let i = 0; i < 4; i++) out.writeBigUInt64LE(s[i], i * 8); return out;
}

// ---------- secp256k1 ----------
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn, N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n, 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n];
const mod = (a, m) => ((a % m) + m) % m;
function inv(a, m) { let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n]; while (r1) { const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; } return mod(s0, m); }
function pow(b, e, m) { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
function add(A, B) {
  if (!A) return B; if (!B) return A; const [x1, y1] = A, [x2, y2] = B;
  if (x1 === x2) { if (mod(y1 + y2, P) === 0n) return null; const l = mod(3n * x1 * x1 * inv(2n * y1, P), P), x = mod(l * l - 2n * x1, P); return [x, mod(l * (x1 - x) - y1, P)]; }
  const l = mod((y2 - y1) * inv(x2 - x1, P), P), x = mod(l * l - x1 - x2, P); return [x, mod(l * (x1 - x) - y1, P)];
}
function mul(A, k) { let R = null; k = mod(k, N); while (k > 0n) { if (k & 1n) R = add(R, A); A = add(A, A); k >>= 1n; } return R; }
const b32 = (x) => Buffer.from(BigInt(x).toString(16).padStart(64, '0'), 'hex'), big = (u) => BigInt('0x' + (hex(u) || '0'));
const addrOfPoint = (Q) => '0x' + hex(keccak(Buffer.concat([b32(Q[0]), b32(Q[1])])).subarray(12));
// The address that produced a 65-byte signature over a 32-byte hash.
export function recover(hash, sigHex) {
  const sig = unhex(sigHex); if (sig.length !== 65) throw new Error('bad signature length');
  const r = big(sig.subarray(0, 32)), s = big(sig.subarray(32, 64)); let v = sig[64]; if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error('bad v'); if (r <= 0n || r >= N || s <= 0n || s > N / 2n) throw new Error('bad r/s');
  const y2 = mod(r * r * r + 7n, P); let y = pow(y2, (P + 1n) / 4n, P); if (y * y % P !== y2) throw new Error('not on curve'); if (Number(y & 1n) !== v) y = P - y;
  const ri = inv(r, N), Q = add(mul([r, y], mod(s * ri, N)), mul(G, mod(-big(hash) * ri, N))); if (!Q) throw new Error('bad point'); return addrOfPoint(Q);
}
// RFC 6979: the nonce comes from the key and the message, so a weak random source can never leak the key
function nonceK(priv, h) { const hm = (k, ...m) => createHmac('sha256', k).update(Buffer.concat(m)).digest(), x = b32(priv); let V = Buffer.alloc(32, 1), K = Buffer.alloc(32);
  K = hm(K, V, Buffer.of(0), x, h); V = hm(K, V); K = hm(K, V, Buffer.of(1), x, h); V = hm(K, V);
  for (;;) { V = hm(K, V); const k = big(V); if (k > 0n && k < N) return k; K = hm(K, V, Buffer.of(0)); V = hm(K, V); } }
function signHash(priv, h) { const k = nonceK(priv, h), R = mul(G, k), r = mod(R[0], N); let s = mod(inv(k, N) * (big(h) + r * priv), N), v = Number(R[1] & 1n); if (s > N / 2n) { s = N - s; v ^= 1; } return { r, s, v }; }
export const personalHash = (msg) => { const m = Buffer.from(msg, 'utf8'); return keccak(Buffer.concat([Buffer.from('\x19Ethereum Signed Message:\n' + m.length), m])); };
export const recoverPersonal = (msg, sig) => recover(personalHash(msg), sig);
// A key the server (or a test) signs with. secret: 32 bytes of hex.
export function signer(secretHex) {
  const raw = unhex(secretHex); if (raw.length !== 32) throw new Error('the secret must be a 32-byte hex private key'); const priv = big(raw); if (priv <= 0n || priv >= N) throw new Error('the secret is not a valid key');
  const sig = (h) => { const { r, s, v } = signHash(priv, h); return { r, s, v, hex: '0x' + hex(b32(r)) + hex(b32(s)) + (27 + v).toString(16) }; };
  return { address: addrOfPoint(mul(G, priv)), signHash: sig, signPersonal: (msg) => sig(personalHash(msg)).hex };
}

// ---------- ABI, RLP and EIP-1559 ----------
const word = (x) => (typeof x === 'string' && x.startsWith('0x') && x.length === 42 ? Buffer.concat([Buffer.alloc(12), unhex(x)]) : b32(x));
export const sel = (signature) => keccak(Buffer.from(signature)).subarray(0, 4);
export const call = (signature, ...args) => '0x' + hex(Buffer.concat([sel(signature), ...args.map(word)]));
const trim = (x) => { x = BigInt(x); return x === 0n ? Buffer.alloc(0) : unhex(x.toString(16)); };
const lenOf = (n, base) => (n < 56 ? Buffer.of(base + n) : (() => { const b = trim(n); return Buffer.concat([Buffer.of(base + 55 + b.length), b]); })());
const rlp = (v) => { if (Array.isArray(v)) { const body = Buffer.concat(v.map(rlp)); return Buffer.concat([lenOf(body.length, 0xc0), body]); } return v.length === 1 && v[0] < 0x80 ? v : Buffer.concat([lenOf(v.length, 0x80), v]); };
export function signTx(key, t) {
  const f = [trim(CHAIN_ID), trim(t.nonce), trim(t.maxPriorityFeePerGas || 0), trim(t.maxFeePerGas), trim(t.gas), unhex(t.to), trim(t.value || 0), unhex(t.data || '0x'), []];
  const { r, s, v } = key.signHash(keccak(Buffer.concat([Buffer.of(2), rlp(f)])));
  return '0x' + hex(Buffer.concat([Buffer.of(2), rlp([...f, trim(v), trim(r), trim(s)])]));
}

// ---------- RPC ----------
const RPCS = (process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com').split(',').map((s) => s.trim()).filter(Boolean);
export async function rpc(method, params = []) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(RPCS[i % RPCS.length], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      if (r.status === 429) { last = new Error('The chain RPC is busy'); await new Promise((ok) => setTimeout(ok, 700 * (i + 1))); continue; }
      const j = await r.json(); if (j.error) throw new Error(j.error.message || 'RPC error'); return j.result;
    } catch (e) { last = e; }
  }
  throw last;
}
export const ethCall = (to, data) => rpc('eth_call', [{ to, data }, 'latest']);
export const balanceOf = async (token, owner) => BigInt(await ethCall(token, call('balanceOf(address)', owner)));
export const decimalsOf = async (token) => Number(BigInt(await ethCall(token, call('decimals()'))));

// What a confirmed transaction from `wallet` paid `treasury`: wei when token is null, otherwise atomic units of that
// token, summed from its Transfer logs. Null until the chain has it.
const TRANSFER = '0x' + hex(keccak(Buffer.from('Transfer(address,address,uint256)')));
const topicAddr = (a) => '0x' + '0'.repeat(24) + lower(a).slice(2);
export async function readPayment(hash, wallet, treasury, token) {
  const rc = await rpc('eth_getTransactionReceipt', [hash]); if (!rc) return null;
  if (rc.status !== '0x1') return { failed: true };
  const signed = !wallet || lower(rc.from) === lower(wallet), payer = lower(rc.from);
  if (!token) { const tx = await rpc('eth_getTransactionByHash', [hash]); return { signed, payer, atomic: tx && lower(tx.to || '') === lower(treasury) ? BigInt(tx.value) : 0n, from: payer }; }
  let atomic = 0n; for (const l of rc.logs || []) if (lower(l.address) === lower(token) && l.topics?.[0] === TRANSFER && l.topics[1] === topicAddr(payer) && l.topics[2] === topicAddr(treasury)) atomic += BigInt(l.data);
  return { signed, payer, atomic, from: payer };
}

// Send one transaction from the treasury key and return its hash.
export async function send(key, to, data = '0x', value = 0n) {
  const [nonce, gasPrice] = await Promise.all([rpc('eth_getTransactionCount', [key.address, 'pending']), rpc('eth_gasPrice')]);
  let gas; try { gas = BigInt(await rpc('eth_estimateGas', [{ from: key.address, to, data, value: '0x' + BigInt(value).toString(16) }])) * 13n / 10n; } catch (e) { throw new Error('the chain refused it: ' + e.message); }
  const fee = BigInt(gasPrice) * 2n;
  return rpc('eth_sendRawTransaction', [signTx(key, { nonce: BigInt(nonce), maxFeePerGas: fee, maxPriorityFeePerGas: 0n, gas, to, value, data })]);
}
export const transferData = (to, atomic) => call('transfer(address,uint256)', to, atomic);

// ---------- EIP-3009: the signed USDG transfer behind an x402 payment ----------
const TYPEHASH_DOMAIN = keccak(Buffer.from('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
const TYPEHASH_AUTH = keccak(Buffer.from('TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'));
export const domainSeparator = (name, version, token) => keccak(Buffer.concat([TYPEHASH_DOMAIN, keccak(Buffer.from(name)), keccak(Buffer.from(version)), b32(CHAIN_ID), word(lower(token))]));
export const authHash = (domain, a) => keccak(Buffer.concat([Buffer.from([0x19, 0x01]), domain, keccak(Buffer.concat([TYPEHASH_AUTH, word(lower(a.from)), word(lower(a.to)), b32(a.value), b32(a.validAfter), b32(a.validBefore), unhex(a.nonce)]))]));
export const settleData = (a, sigHex) => { const s = unhex(sigHex); return '0x' + hex(Buffer.concat([sel('transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)'), word(lower(a.from)), word(lower(a.to)), b32(a.value), b32(a.validAfter), b32(a.validBefore), unhex(a.nonce), b32(s[64] < 27 ? s[64] + 27 : s[64]), s.subarray(0, 32), s.subarray(32, 64)])); };

// Dollar price of a token on Robinhood Chain from GeckoTerminal, keyless.
export async function usdPrice(token) {
  const r = await fetch('https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/' + lower(token), { signal: AbortSignal.timeout(10000) }), j = await r.json();
  const p = Number(j?.data?.attributes?.price_usd); if (!(p > 0)) throw new Error('no price for ' + token); return p;
}
