// Shared by every page: the API, the wallet, and the transactions a wallet sends.
export const $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const money = (n, d = 2) => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: Math.max(d, n < 0.1 ? 4 : d) });
export const credits = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: n < 10 ? 4 : 2, maximumFractionDigits: n < 10 ? 4 : 2 });
export const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
export const ago = (t) => { const s = Math.max(1, Math.round((Date.now() - t) / 1000)); return s < 60 ? s + 's ago' : s < 3600 ? Math.round(s / 60) + 'm ago' : s < 86400 ? Math.round(s / 3600) + 'h ago' : Math.round(s / 86400) + 'd ago'; };
export const clock = (s) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((x) => String(x).padStart(2, '0')).join(':');
export const EXPLORER = 'https://explorer.mainnet.chain.robinhood.com', txUrl = (h) => `${EXPLORER}/tx/${h}`;

let toastTimer; export function toast(msg, bad) { let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.append(t); } t.textContent = msg; t.classList.toggle('bad', !!bad); t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), bad ? 5200 : 3200); }
export const copy = async (text, what = 'Copied') => { try { await navigator.clipboard.writeText(text); toast(what); } catch { toast('Copy it by hand: ' + text); } };

export const session = { get token() { try { return sessionStorage.getItem('rig_token') || ''; } catch { return ''; } }, get wallet() { try { return sessionStorage.getItem('rig_wallet') || ''; } catch { return ''; } },
  set(token, wallet) { try { sessionStorage.setItem('rig_token', token); sessionStorage.setItem('rig_wallet', wallet); } catch { /* private window */ } }, clear() { try { sessionStorage.removeItem('rig_token'); sessionStorage.removeItem('rig_wallet'); } catch { /* private window */ } } };
export async function api(path, { method, body, raw } = {}) {
  const r = await fetch(path, { method: method || (body ? 'POST' : 'GET'), headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(session.token ? { authorization: 'Bearer ' + session.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (raw) return r; let j = {}; try { j = await r.json(); } catch { /* empty */ }
  if (r.status === 401 && session.token) { session.clear(); location.reload(); }
  if (!r.ok) throw Object.assign(new Error(j.error || 'Request failed'), { status: r.status }); return j;
}
let cfg; export const config = () => (cfg ||= api('/api/config'));

// ---------- the wallet: any browser wallet that speaks EIP-1193 (MetaMask, Rabby, Robinhood Wallet) ----------
const CHAIN = { chainId: '0x1237', chainName: 'Robinhood Chain', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'], blockExplorerUrls: [EXPLORER] };
export const provider = () => window.ethereum || null;
const hexOf = (text) => '0x' + [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('');
const friendly = (e) => new Error(e?.code === 4001 ? 'You declined it in your wallet' : e?.message || 'The wallet refused it');
export async function onChain() {
  const eth = provider(); if ((await eth.request({ method: 'eth_chainId' })) === CHAIN.chainId) return;
  try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAIN.chainId }] }); }
  catch (e) { if (e?.code === 4902 || /unrecognized|not been added|unknown chain/i.test(e?.message || '')) await eth.request({ method: 'wallet_addEthereumChain', params: [CHAIN] }); else throw friendly(e); }
}
export async function connect() {
  const eth = provider(); if (!eth) { toast('Install a wallet such as MetaMask or Rabby to connect', true); return null; }
  try { const [account] = await eth.request({ method: 'eth_requestAccounts' }), wallet = account.toLowerCase();
    const { message } = await api('/api/auth/nonce', { body: { wallet } });
    const signature = await eth.request({ method: 'personal_sign', params: [hexOf(message), wallet] });
    const v = await api('/api/auth/verify', { body: { wallet, signature } }); session.set(v.token, v.wallet); return v.wallet;
  } catch (e) { throw e.status ? e : friendly(e); }
}
// Send one transaction from the signed-in wallet on Robinhood Chain and return its hash.
export async function sendTx(tx) { const eth = provider(); if (!eth) throw new Error('Open your wallet to send it'); await onChain(); try { return await eth.request({ method: 'eth_sendTransaction', params: [{ from: session.wallet, ...tx }] }); } catch (e) { throw friendly(e); } }
export const toHex = (n) => '0x' + BigInt(n).toString(16);

// nav links that only exist once they are set
export async function nav() { try { const c = await config(); for (const [id, u] of [['xlink', c.x], ['ghlink', c.gh]]) for (const a of $$('.' + id)) { if (u) { a.href = u; a.hidden = false; } } return c; } catch { return {}; } }
