// The RIG dashboard: one page, nine views, no framework.
import { $, $$, api, nav, money, credits, esc, copy, toast, short, ago, clock, session, connect, sendTx, toHex, txUrl, config } from '/common.js';

const view = $('#view'); let cfg = {}, RATE = 0.7, timer = null, models = null, gpus = null;
const on = (price) => price * RATE, signedIn = () => !!session.token;
const stop = () => { clearInterval(timer); timer = null; };
const every = (ms, f) => { stop(); timer = setInterval(() => f().catch(() => {}), ms); };
const gate = (title, text) => { view.innerHTML = `<div class="gate"><h1>${title}</h1><p class="mute">${text}</p><div><button class="btn ink" id="gatebtn">Connect wallet</button></div></div>`; $('#gatebtn').onclick = signIn; };
const need = (title) => { if (signedIn()) return false; gate(title, 'Your wallet is your account. Signing in costs no gas and moves no funds.'); return true; };
const fail = (e) => toast(e.message || 'Something went wrong', true);
const price = (listed, unit = '') => `<span class="strike num">${money(listed, listed < 0.1 ? 3 : 2)}</span> <b class="num">${money(on(listed), listed < 0.1 ? 4 : 2)}</b>${unit}`;

async function signIn() { try { const w = await connect(); if (w) { toast('Signed in as ' + short(w)); await top(); route(); } } catch (e) { fail(e); } }
async function top() {
  const b = $('#wallet'), bal = $('#bal');
  if (!signedIn()) { b.textContent = 'Connect wallet'; b.onclick = signIn; bal.hidden = true; return; }
  b.textContent = short(session.wallet); b.onclick = () => { session.clear(); location.hash = '#/playground'; location.reload(); };
  try { const c = await api('/api/v1/credits'); bal.textContent = credits(c.credits) + ' credits'; bal.hidden = false; } catch { /* not signed in any more */ }
}

// ---------- overview ----------
async function overview() {
  if (need('Your account')) return; const o = await api('/api/overview'), max = Math.max(...o.spend.map((d) => d.credits), 0.000001);
  view.innerHTML = `<h1>Overview</h1><p class="mute">Your credits, what you spent, and what is running.</p>
    <div class="grid3"><div class="slab stat"><span class="lbl">Credits</span><b class="num">${credits(o.credits)}</b><a class="btn line sm" href="#/billing">Buy credits</a></div>
      <div class="slab stat"><span class="lbl">Spent today (UTC)</span><b class="num">${credits(o.spentToday)}</b><span class="mute">a credit costs ${money(o.creditPrice)} USDG</span></div>
      <div class="slab stat"><span class="lbl">Free outputs left today</span><b class="num">${o.free.holder ? o.free.images + ' · ' + o.free.videos : '0'}</b><span class="mute">${o.free.holder ? 'images · videos' : 'hold 1,000 $RIG to unlock them'}</span></div></div>
    <div class="slab" style="margin-top:18px"><span class="lbl">Spend, last 14 days</span><div class="bars">${o.spend.map((d) => `<i class="${d.credits ? '' : 'z'}" style="height:${Math.max(2, d.credits / max * 100)}%" title="${d.day}: ${credits(d.credits)} credits"></i>`).join('')}</div></div>
    <div class="slab" style="margin-top:18px"><span class="lbl">Recent activity</span>${history(o.history)}</div>`;
}
const history = (h) => (h.length ? `<table><thead><tr><th>When</th><th>What</th><th>Detail</th><th class="r">Credits</th></tr></thead><tbody>${h.map((l) => `<tr><td class="mute">${ago(l.ts)}</td><td class="mono">${l.kind}</td><td class="mute">${l.tx ? `<a href="${txUrl(esc(l.tx))}" target="_blank" rel="noopener noreferrer">${esc(l.note || '')} ${short(l.tx)} ↗</a>` : esc(l.note || l.ref || '')}</td><td class="r num">${l.credits > 0 ? '+' : ''}${credits(l.credits)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nothing yet. Buy credits to start.</div>');

// ---------- playground ----------
const pick = { model: 'flux-schnell', size: 'square', seconds: 5 };
async function playground() {
  models ||= (await api('/api/v1/models')).models; const m = models.find((x) => x.id === pick.model) || models[0]; if (!m.sizes.includes(pick.size)) pick.size = m.sizes[0]; if (m.videoSeconds && !m.videoSeconds.includes(pick.seconds)) pick.seconds = m.videoSeconds[0];
  const mp = { square: 1.048576, wide: 1.032192, tall: 1.032192 }[pick.size], units = m.unit === '1 megapixel' ? mp : m.kind === 'video' ? pick.seconds / 5 : 1, cost = m.listed * units, voice = m.kind === 'voice';
  view.innerHTML = `<h1>Playground</h1><p class="mute">Send a prompt to a ready model. It takes its credits when you press Make and gives them back if it fails.</p>
    <div class="grid2"><div class="slab">
      <div class="field"><span class="lbl">Model</span><select id="pm">${['image', 'video', 'voice'].map((k) => `<optgroup label="${k}">${models.filter((x) => x.kind === k).map((x) => `<option value="${x.id}" ${x.id === m.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</optgroup>`).join('')}</select></div>
      <div class="field"><span class="lbl">${voice ? 'Text to speak, up to 1,000 characters' : 'Prompt, up to 2,000 characters'}</span><textarea id="pp" maxlength="${voice ? 1000 : 2000}" placeholder="${voice ? 'Welcome to RIG.' : 'A studio photo of a GPU on a marble table'}">${esc(pick.prompt || '')}</textarea></div>
      ${voice ? '' : `<div class="field"><span class="lbl">Size</span><div class="seg" id="ps">${m.sizes.map((s) => `<button class="${s === pick.size ? 'on' : ''}" data-v="${s}">${s}</button>`).join('')}</div></div>`}
      ${m.videoSeconds ? `<div class="field"><span class="lbl">Length</span><div class="seg" id="pl">${m.videoSeconds.map((s) => `<button class="${s === pick.seconds ? 'on' : ''}" data-v="${s}">${s} seconds</button>`).join('')}</div></div>` : ''}
      <div class="row between" style="margin:8px 0 18px"><span class="lbl">Price</span><span>${price(cost)} <span class="mute">· ${esc(m.unit)}</span></span></div>
      <button class="btn ink wide" id="make">${signedIn() ? 'Make ' + m.kind : 'Connect wallet to make'}</button>
      ${cfg.provider ? '' : '<p class="mute" style="margin-top:14px;font-size:14px">The GPU provider is being connected. Making opens the moment it is.</p>'}</div>
    <div class="slab"><span class="lbl">Result</span><div id="result" class="empty">Your output appears here.</div></div></div>`;
  $('#pm').onchange = (e) => { pick.model = e.target.value; pick.prompt = $('#pp').value; playground(); };
  for (const [sel, key, num] of [['#ps', 'size', 0], ['#pl', 'seconds', 1]]) $$(sel + ' button').forEach((b) => { b.onclick = () => { pick[key] = num ? +b.dataset.v : b.dataset.v; pick.prompt = $('#pp').value; playground(); }; });
  $('#make').onclick = async () => { if (!signedIn()) return signIn(); const prompt = $('#pp').value.trim(); if (!prompt) return toast('Write a prompt first', true); pick.prompt = prompt; const btn = $('#make'); btn.disabled = true;
    try { let o = await api('/api/v1/outputs', { body: { model: m.id, prompt, size: pick.size, seconds: pick.seconds } }); $('#result').innerHTML = '<div style="display:grid;place-items:center;gap:14px;padding:50px 0"><div class="spin"><b></b><b></b><b></b><b></b></div><span class="lbl">Making. You can leave this page.</span></div>'; top();
      for (let i = 0; i < 600 && o.status === 'making'; i++) { await new Promise((r) => setTimeout(r, 1200)); o = await api('/api/v1/outputs/' + o.id + '?inline=0'); }
      $('#result').className = ''; $('#result').innerHTML = o.status === 'ready' ? `<div class="out" style="margin-top:12px">${await media(o)}<div class="b"><div class="row between"><span class="lbl">${o.free ? 'Free' : credits(o.credits) + ' credits'}</span><a class="btn line sm" id="dl">Download</a></div></div></div>` : `<div class="empty">It failed: ${esc(o.reason || 'unknown reason')}. Its credits came back.</div>`;
      if (o.status === 'ready') $('#dl').onclick = () => download(o); top();
    } catch (e) { fail(e); } btn.disabled = false; };
}
// files need the session header, so they load through fetch into a blob
const blobs = new Map();
async function blobOf(o) { if (blobs.has(o.id)) return blobs.get(o.id); const r = await api(o.file, { raw: true }); if (!r.ok) throw new Error('The file is gone'); const u = URL.createObjectURL(await r.blob()); blobs.set(o.id, u); return u; }
async function media(o) { try { const u = await blobOf(o); return `<div class="m">${o.kind === 'image' ? `<img src="${u}" alt="${esc(o.prompt)}">` : o.kind === 'video' ? `<video src="${u}" controls loop playsinline></video>` : `<audio src="${u}" controls></audio>`}</div>`; } catch { return '<div class="m"><span class="lbl">file expired</span></div>'; } }
async function download(o) { try { const a = document.createElement('a'); a.href = await blobOf(o); a.download = o.id + '.' + (o.mime || '').split('/')[1]; a.click(); } catch (e) { fail(e); } }

async function outputs() {
  if (need('Your outputs')) return; const { outputs: list } = await api('/api/v1/outputs');
  view.innerHTML = `<h1>Outputs</h1><p class="mute">Everything you made in the last 24 hours. Download a file to keep it longer.</p>${list.length ? '<div class="outs" id="outs"></div>' : '<div class="empty">Nothing yet. <a href="#/playground"><u>Open the Playground</u></a></div>'}`;
  for (const o of list) { const el = document.createElement('div'); el.className = 'out'; el.innerHTML = `${o.status === 'ready' ? await media(o) : `<div class="m">${o.status === 'making' ? '<div class="spin"><b></b><b></b><b></b><b></b></div>' : '<span class="lbl">failed</span>'}</div>`}<div class="b"><p>${esc(o.prompt)}</p><div class="row between" style="margin-top:8px"><span class="lbl">${esc(o.model)} · ${o.free ? 'free' : credits(o.credits)}</span>${o.status === 'ready' ? '<a class="btn line sm">Save</a>' : ''}</div></div>`; const b = $('a.btn', el); if (b) b.onclick = () => download(o); $('#outs').append(el); }
  if (list.some((o) => o.status === 'making')) every(2500, outputs);
}

// ---------- marketplace and instances ----------
async function marketplace() {
  gpus = (await api('/api/v1/gpus')).gpus; const los = (await api('/api/v1/loadouts')).loadouts; let fz = 0, lo = sessionStorage.getItem('rig_loadout') || 'pytorch'; if (!los.some((l) => l.id === lo)) lo = 'pytorch'; const open = gpus.filter((g) => g.available);
  view.innerHTML = `<h1>Marketplace</h1><p class="mute">${gpus.length} NVIDIA GPUs at one rate per hour, billed by the second. A busy GPU charges nothing.</p>
    <div class="slab" style="margin-bottom:18px"><span class="lbl">Loadout · what your instance boots with</span><div class="los" id="los">${los.map((l) => `<button data-lo="${esc(l.id)}"><b>${esc(l.name)}</b><span>${esc(l.blurb)}</span><i>${l.port ? 'port ' + l.port : 'SSH only'}</i></button>`).join('')}</div><span class="lbl" style="display:block;margin-top:18px">Fuse · the instance ends itself after this much running time</span><div class="seg" id="fz" style="margin-top:10px">${[[0, 'No fuse'], [30, '30 min'], [60, '1 hour'], [240, '4 hours'], [720, '12 hours']].map(([m, t]) => `<button data-fz="${m}">${t}</button>`).join('')}</div></div>
    <div class="slab" style="margin-bottom:18px"><div class="row between"><div><span class="lbl">rig/auto</span><h3 style="margin-top:6px">Rent the cheapest GPU with at least <span id="mv">24</span> GB</h3></div><button class="btn ink" id="auto">Rent the cheapest</button></div><input type="range" id="mr" min="16" max="${Math.max(...gpus.map((g) => g.vram))}" step="4" value="24" style="margin-top:12px" aria-label="Memory needed in GB"><p class="mute" id="mh" style="margin-top:6px"></p></div>
    <div class="slab"><table><thead><tr><th>GPU</th><th>Memory</th><th class="r">Per hour</th><th class="r"></th></tr></thead><tbody>${gpus.map((g) => `<tr><td><b>${esc(g.name)}</b></td><td class="num mute">${g.vram} GB</td><td class="r">${price(g.listed)}</td><td class="r">${g.available ? `<button class="btn line sm" data-g="${esc(g.id)}">Rent</button>` : '<span class="pill off">busy</span>'}</td></tr>`).join('')}</tbody></table></div>`;
  const hint = () => { const v = +$('#mr').value, h = open.find((g) => g.vram >= v); $('#mv').textContent = v; $('#mh').textContent = h ? `That is the ${h.name} with ${h.vram} GB at ${money(on(h.listed))} an hour.` : 'No open GPU has that much memory right now.'; }; $('#mr').oninput = hint; hint();
  const go = async (body) => { if (!signedIn()) return signIn(); try { await api('/api/v1/instances', { body: { ...body, loadout: lo, ...(fz ? { fuse: fz } : {}) } }); toast('Starting your instance'); location.hash = '#/instances'; } catch (e) { fail(e); if (/SSH key/.test(e.message)) location.hash = '#/ssh'; if (e.status === 402) location.hash = '#/billing'; } };
  const pick = () => $$('#los button').forEach((b) => b.classList.toggle('on', b.dataset.lo === lo)); $$('#los button').forEach((b) => { b.onclick = () => { lo = b.dataset.lo; try { sessionStorage.setItem('rig_loadout', lo); } catch {} pick(); }; }); pick();
  const fuse = () => $$('#fz button').forEach((b) => b.classList.toggle('on', +b.dataset.fz === fz)); $$('#fz button').forEach((b) => { b.onclick = () => { fz = +b.dataset.fz; fuse(); }; }); fuse();
  $('#auto').onclick = () => go({ gpu: 'auto', vram: +$('#mr').value }); $$('[data-g]').forEach((b) => { b.onclick = () => go({ gpu: b.dataset.g }); });
}
async function instances() {
  if (need('Your instances')) return; const { instances: list, fleet } = await api('/api/v1/instances'), bal = (await api('/api/v1/credits')).credits, liveOnes = list.filter((i) => ['starting', 'running'].includes(i.status)), done = list.filter((i) => !liveOnes.includes(i));
  view.innerHTML = `<h1>My instances</h1><p class="mute">Billing starts the second SSH is ready and stops the second you end the instance. Leaving SSH does not end it.</p>
    ${fleet && liveOnes.length ? `<div class="slab" style="margin-bottom:18px"><div class="row between"><div><span class="lbl">Fleet</span><div class="num" style="font-size:26px">${fleet.running} of ${fleet.max} running</div></div><div><span class="lbl">Together</span><div class="num grn" style="font-size:26px">${money(fleet.rate * RATE)} / hr</div></div>${fleet.running < fleet.max ? '<a class="btn" href="#/marketplace">Add a GPU</a>' : ''}</div></div>` : ''}
    ${liveOnes.map((i) => { const left = i.status === 'running' ? bal / (fleet?.rate || i.rate) * 60 : null; return `<div class="slab" style="margin-bottom:18px"><div class="row between"><div><span class="pill ${i.status === 'running' ? 'on' : ''}">${i.status}</span><h3 style="font-size:34px;margin-top:10px">${esc(i.gpu)} <span class="mute" style="font-size:.5em">${i.vram} GB · ${esc(i.loadout?.name || '')}</span></h3></div><button class="btn line" data-end="${i.id}">End instance</button></div>
      <div class="grid3" style="margin-top:18px"><div><span class="lbl">Elapsed</span><div class="num" style="font-size:26px">${clock(i.seconds)}</div></div><div><span class="lbl">Rate</span><div class="num" style="font-size:26px">${money(i.rate * RATE)} / hr</div></div><div><span class="lbl">Cost so far</span><div class="num" style="font-size:26px">${credits(i.credits)} credits</div></div></div>${i.fuse ? `<p class="num grn" style="margin-top:14px">FUSE · ${i.fuseEnds ? 'ends itself in ' + clock(Math.max(0, Math.round((i.fuseEnds - Date.now()) / 1000))) : 'starts counting when SSH is ready'}</p>` : ''}
      ${i.status === 'running' ? `<span class="lbl" style="display:block;margin-top:18px">SSH · add -i ~/.ssh/rig</span><code class="box" data-copy>${esc(i.ssh)}</code>${i.tunnel ? `<span class="lbl">${esc(i.loadout.app)} tunnel, then open http://localhost:${i.loadout.port}</span><code class="box" data-copy>${esc(i.tunnel)}</code>` : ''}${left !== null && left < 10 ? `<p style="color:var(--bad)">Your credits pay for about ${Math.max(0, Math.floor(left))} more minutes. <a href="#/billing"><u>Add credits</u></a> to keep it running.</p>` : ''}` : '<div class="row" style="margin-top:18px"><div class="spin"><b></b><b></b><b></b><b></b></div><span class="mute">Starting. The start is free: nothing is billed until SSH is ready.</span></div>'}</div>`; }).join('') || '<div class="slab empty">Nothing is running. <a href="#/marketplace"><u>Rent a GPU</u></a></div>'}
    ${done.length ? `<div class="slab" style="margin-top:18px"><span class="lbl">Ended in the last day</span><table><thead><tr><th>GPU</th><th>Ran</th><th>Why it ended</th><th class="r">Credits</th></tr></thead><tbody>${done.map((i) => `<tr><td><b>${esc(i.gpu)}</b></td><td class="num mute">${clock(i.seconds)}</td><td class="mute">${esc(i.reason || '')}</td><td class="r num">${credits(i.credits)}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  $$('[data-end]').forEach((b) => { b.onclick = async () => { b.disabled = true; try { await api(`/api/v1/instances/${b.dataset.end}/terminate`, { method: 'POST' }); toast('Instance ended'); instances(); top(); } catch (e) { fail(e); } }; });
  $$('[data-copy]').forEach((c) => { c.style.cursor = 'copy'; c.onclick = () => copy(c.textContent, 'Command copied'); });
  if (liveOnes.length) every(liveOnes.some((i) => i.status === 'starting') ? 2500 : 5000, async () => { await instances(); top(); });
}
async function ssh() {
  if (need('Your SSH keys')) return; const { keys } = await api('/api/v1/ssh-keys');
  view.innerHTML = `<h1>SSH keys</h1><p class="mute">A wallet keeps up to 10 keys, and every new instance takes all of them.</p>
    <div class="grid2"><div class="slab"><span class="lbl">Make a key on your computer</span><code class="box">ssh-keygen -t ed25519 -f ~/.ssh/rig -C "rig"
cat ~/.ssh/rig.pub</code><div class="field"><span class="lbl">Name</span><input id="sn" maxlength="40" placeholder="laptop"></div><div class="field"><span class="lbl">Public key, the one line the second command prints</span><textarea id="sk" placeholder="ssh-ed25519 AAAA…"></textarea></div><button class="btn ink wide" id="sa">Add key</button></div>
    <div class="slab"><span class="lbl">Your keys</span>${keys.length ? `<table><tbody>${keys.map((k) => `<tr><td><b>${esc(k.name)}</b><div class="mute num" style="font-size:12px">${esc(k.key.slice(0, 42))}…</div></td><td class="r"><button class="btn line sm" data-d="${k.id}">Remove</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No keys yet.</div>'}</div></div>`;
  $('#sa').onclick = async () => { try { await api('/api/v1/ssh-keys', { body: { name: $('#sn').value, key: $('#sk').value } }); toast('Key added'); ssh(); } catch (e) { fail(e); } };
  $$('[data-d]').forEach((b) => { b.onclick = async () => { try { await api('/api/v1/ssh-keys/' + b.dataset.d, { method: 'DELETE' }); ssh(); } catch (e) { fail(e); } }; });
}

// ---------- billing ----------
let payWith = 'usdg';
// a payment that was sent but not yet confirmed is remembered, and credited the next time Billing opens
const pending = (v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem('rig_pending') || 'null'); if (v) localStorage.setItem('rig_pending', JSON.stringify(v)); else localStorage.removeItem('rig_pending'); } catch { /* private window */ } return null; };
async function billing() {
  if (need('Billing')) return;
  const p = pending(); if (p) { try { const c = await api('/api/billing/confirm', { body: { pay: p.pay, signature: p.sig } }); pending(null); toast(`${credits(c.credits)} credits added`); top(); } catch (e) { if (e.status !== 404) pending(null); } }
  const o = await api('/api/overview');
  view.innerHTML = `<h1>Billing</h1><p class="mute">One credit pays for $1 of outputs and rentals at listed prices. A credit costs ${money(o.creditPrice)} USDG, so everything is ${Math.round((1 - o.creditPrice) * 100)}% off.</p>
    <div class="grid2"><div class="slab"><span class="lbl">Buy credits</span>
      <div class="field" style="margin-top:14px"><span class="lbl">Pay with</span><div class="seg" id="bw">${[['usdg', 'USDG'], ['eth', 'ETH'], ...(cfg.token ? [['token', '$RIG']] : [])].map(([v, l]) => `<button class="${v === payWith ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}</div></div>
      <div class="field"><span class="lbl">Amount in dollars, 5 to 1,000</span><input id="ba" type="number" min="5" max="1000" step="1" value="10" style="font:600 34px var(--disp);letter-spacing:-.02em"></div>
      <div class="row between" style="margin-bottom:18px"><span class="lbl">You get</span><b class="num" id="bg" style="font-size:22px"></b></div>
      <button class="btn ink wide" id="bb">Buy credits</button><p class="mute" id="bn" style="margin-top:12px;font-size:14px">${cfg.treasury ? 'The transfer goes to the RIG treasury on Robinhood Chain. Credits show up when the chain confirms it.' : 'Deposits open as soon as the treasury address is published.'}</p></div>
    <div class="slab"><span class="lbl">Balance</span><div class="stat"><b class="num">${credits(o.credits)}</b></div>${o.lots.filter((l) => l.left > 0).length ? `<table><thead><tr><th>Bought with</th><th>Left</th><th class="r">When</th></tr></thead><tbody>${o.lots.filter((l) => l.left > 0).map((l) => `<tr><td class="mono">${l.src === 'token' ? '$RIG' : l.src}</td><td class="num">${credits(l.left)}</td><td class="r mute">${ago(l.ts)}</td></tr>`).join('')}</tbody></table>` : ''}
      <span class="lbl" style="display:block;margin-top:22px">Refund credits</span><p class="mute" style="font-size:14px;margin:6px 0 12px">Unused credits go back to this wallet at the price you paid, each in the asset it paid with. A refund takes your whole balance, starts at 1 USDG, and waits while an instance runs.</p><button class="btn line" id="br">Refund my balance</button></div></div>
    <div class="slab" style="margin-top:18px"><span class="lbl">History</span>${history(o.history)}</div>`;
  const amt = () => Math.max(0, +$('#ba').value || 0), get = () => { $('#bg').textContent = credits(Math.floor(amt() / o.creditPrice * 1e6) / 1e6) + ' credits'; }; $('#ba').oninput = get; get();
  $$('#bw button').forEach((b) => { b.onclick = () => { payWith = b.dataset.v; billing(); }; });
  $('#bb').onclick = async () => { const btn = $('#bb'); btn.disabled = true; try {
      const i = await api('/api/billing/intent', { body: { pay: payWith, amount: amt() } });
      if (i.holds !== undefined && BigInt(i.holds) < BigInt(i.atomic)) throw new Error('This wallet does not hold enough of it');
      const sig = await sendTx(payWith === 'eth' ? { to: i.treasury, value: toHex(i.wei) } : { to: i.token, data: i.data }); pending({ pay: payWith, sig }); toast('Sent. Waiting for the chain to confirm…');
      for (let n = 0; n < 40; n++) { await new Promise((r) => setTimeout(r, 1500)); try { const c = await api('/api/billing/confirm', { body: { pay: payWith, signature: sig } }); pending(null); toast(`${credits(c.credits)} credits added`); top(); return billing(); } catch (e) { if (e.status !== 404) throw e; } }
      throw new Error('The chain has not confirmed it yet. Reopen Billing in a minute and it will be credited.');
    } catch (e) { fail(e); } btn.disabled = false; };
  $('#br').onclick = async () => { if (!confirm('Refund your whole balance to this wallet?')) return; try { const r = await api('/api/billing/refund', { method: 'POST' }); toast(r.state === 'sent' ? 'Refund sent to your wallet' : 'Refund queued. It reaches your wallet shortly.'); top(); billing(); } catch (e) { fail(e); } };
}

// ---------- API keys ----------
async function apiKeys() {
  if (need('API & x402')) return; const { keys } = await api('/api/keys'), base = location.origin;
  view.innerHTML = `<h1>API &amp; x402</h1><p class="mute">A key acts for your wallet at the same listed prices. It never refunds credits, signs in, or makes other keys.</p>
    <div class="grid2"><div class="slab"><span class="lbl">Make an API key</span><div class="field" style="margin-top:14px"><span class="lbl">Name</span><input id="kn" maxlength="40" placeholder="my agent"></div><div class="field"><span class="lbl">Spend cap per UTC day, in credits (leave empty for none)</span><input id="kc" type="number" min="0.01" max="10000" step="0.01" placeholder="20"></div><button class="btn ink wide" id="km">Make key</button><div id="knew"></div></div>
    <div class="slab"><span class="lbl">Your keys</span>${keys.length ? `<table><thead><tr><th>Key</th><th>Spent today</th><th class="r"></th></tr></thead><tbody>${keys.map((k) => `<tr><td><b>${esc(k.name)}</b> <span class="mute num">rgk_…${esc(k.tail)}</span><div><span class="pill ${k.stopped ? 'off' : 'on'}">${k.stopped ? 'stopped' : 'live'}</span></div></td><td class="num">${credits(k.spentToday)}${k.cap ? ` <span class="mute">of ${credits(k.cap)}</span>` : ''}</td><td class="r"><button class="btn line sm" data-s="${k.id}" data-v="${k.stopped ? 0 : 1}">${k.stopped ? 'Start' : 'Stop'}</button> <button class="btn line sm" data-x="${k.id}">Delete</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No keys yet.</div>'}</div></div>
    <div class="grid2" style="margin-top:18px"><div class="slab"><span class="lbl">Call the API</span><code class="box">curl ${base}/api/v1/outputs \\
  -H "Authorization: Bearer $RIG_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model": "flux-schnell", "prompt": "A lighthouse at dusk"}'</code><span class="lbl">Connect an agent over MCP</span><code class="box">claude mcp add --transport http rig ${base}/mcp \\
  --header "Authorization: Bearer $RIG_KEY"</code></div>
    <div class="slab"><span class="lbl">x402: no key at all</span><p class="mute" style="margin:10px 0">Send the same request with no Authorization header. RIG answers 402 with the price in the PAYMENT-REQUIRED header. Sign that USDG transfer (EIP-3009), send the request again with PAYMENT-SIGNATURE, and the output comes back in the same answer.</p><code class="box">network  ${esc(cfg.network || '')}
asset    ${esc(cfg.usdg || '')} (USDG)
payTo    ${esc(cfg.treasury || 'published when deposits open')}</code><a class="btn line sm" href="/docs#x402">How x402 works</a></div></div>`;
  $('#km').onclick = async () => { try { const k = await api('/api/keys', { body: { name: $('#kn').value, cap: $('#kc').value } }); await apiKeys(); $('#knew').innerHTML = `<span class="lbl" style="display:block;margin-top:18px">Copy it now. It is shown this once.</span><code class="box" id="kraw" style="cursor:copy">${esc(k.key)}</code>`; $('#kraw').onclick = () => copy(k.key, 'Key copied'); } catch (e) { fail(e); } };
  $$('[data-s]').forEach((b) => { b.onclick = async () => { try { await api('/api/keys/' + b.dataset.s, { method: 'PATCH', body: { stopped: b.dataset.v === '1' } }); apiKeys(); } catch (e) { fail(e); } }; });
  $$('[data-x]').forEach((b) => { b.onclick = async () => { if (!confirm('Delete this key? Its next request is refused.')) return; try { await api('/api/keys/' + b.dataset.x, { method: 'DELETE' }); apiKeys(); } catch (e) { fail(e); } }; });
}

// ---------- receipts, checked in the browser ----------
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
async function receipts() {
  if (need('Your receipts')) return; const { receipts: list } = await api('/api/v1/receipts');
  view.innerHTML = `<h1>Receipts</h1><p class="mute">One for every output and every rental. Each hour is hashed into one root and the root is written to Robinhood Chain. Press Check and this browser rebuilds the proof itself.</p>
    <div class="slab">${list.length ? `<table><thead><tr><th>When</th><th>What</th><th>GPU seconds</th><th>Credits</th><th class="r">Hour</th><th class="r"></th></tr></thead><tbody>${list.map((r) => `<tr><td class="mute">${ago(r.ts)}</td><td><b>${esc(r.what)}</b> <span class="mono mute">${r.kind}</span></td><td class="num mute">${r.seconds || '–'}</td><td class="num">${credits(r.credits)}</td><td class="r">${r.tx ? `<a class="pill on" href="${txUrl(esc(r.tx))}" target="_blank" rel="noopener noreferrer">onchain ↗</a>` : `<span class="pill ${r.sealed ? '' : 'off'}">${r.sealed ? 'sealed' : 'open'}</span>`}</td><td class="r"><button class="btn line sm" data-r="${r.id}">Check</button></td></tr>`).join('')}</tbody></table>` : '<div class="empty">No receipts yet. Make an output or rent a GPU.</div>'}</div><div id="proof"></div>`;
  $$('[data-r]').forEach((b) => { b.onclick = async () => { try { const p = await api(`/api/receipts/${b.dataset.r}/proof`); let h = await sha(p.fields.split('|').map((k) => p.receipt[k]).join('|')); const leafOk = h === p.leaf; for (const s of p.path) h = await sha(h < s ? h + s : s + h); const ok = leafOk && h === p.root;
        $('#proof').innerHTML = `<div class="slab" style="margin-top:18px"><span class="pill ${ok ? 'on' : 'off'}">${ok ? 'proof holds' : 'proof does not hold'}</span><table style="margin-top:14px"><tbody><tr><td class="lbl">Leaf</td><td class="num mute">${p.leaf}</td></tr><tr><td class="lbl">Steps</td><td class="num mute">${p.path.length}</td></tr><tr><td class="lbl">Root of its hour</td><td class="num">${p.root}</td></tr><tr><td class="lbl">On Robinhood Chain</td><td>${p.tx ? `<a href="${txUrl(esc(p.tx))}" target="_blank" rel="noopener noreferrer"><u>${short(p.tx)} ↗</u></a>` : p.sealed ? 'sealed, transaction being written' : 'this hour seals at the top of the next one'}</td></tr></tbody></table></div>`; $('#proof').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (e) { fail(e); } }; });
}

const ROUTES = { overview, playground, outputs, marketplace, instances, ssh, billing, api: apiKeys, receipts };
async function route() { stop(); const name = (location.hash.replace(/^#\/?/, '') || 'playground').split('?')[0], f = ROUTES[name] || playground; $$('#side a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === '#/' + (ROUTES[name] ? name : 'playground'))); try { await f(); } catch (e) { view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; } }
addEventListener('hashchange', () => { scrollTo(0, 0); route(); });
(async () => { cfg = await nav(); try { cfg = await config(); RATE = cfg.creditPrice || 0.7; } catch { /* keep defaults */ } await top(); route(); })();
