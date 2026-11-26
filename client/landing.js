// Landing: a wall of GPU fans that run hotter near the cursor, and the live market beside it.
import { $, $$, api, nav, money, esc, copy, txUrl } from '/common.js';

// ---------- the fan wall ----------
const cv = $('#fans'), gl = cv.getContext('webgl', { antialias: false, alpha: false });
if (gl) {
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const pr = gl.createProgram();
  gl.attachShader(pr, sh(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'));
  gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, `precision highp float;uniform vec2 r;uniform vec2 m;uniform float t;
    float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
    void main(){vec2 uv=gl_FragCoord.xy/r.y;float cells=4.2;vec2 g=uv*cells;vec2 id=floor(g);vec2 f=fract(g)-.5;
      float d=length(f),a=atan(f.y,f.x),rnd=h(id);
      float load=smoothstep(.85,.0,distance(uv,vec2(m.x*r.x/r.y,m.y)));                                // how close the cursor is: the fan's load
      float dir=mod(id.x+id.y,2.)<1.?1.:-1.;float spin=t*(1.1+rnd*1.6)*dir+rnd*6.283;
      float blade=sin(7.*(a+spin)-d*9.);                                                                // seven swept blades
      float inFan=smoothstep(.41,.39,d)*smoothstep(.10,.12,d);
      float blades=smoothstep(.15,.75,blade)*inFan;
      float ring=smoothstep(.012,.0,abs(d-.43))+smoothstep(.01,.0,abs(d-.10))*.8;                         // shroud and hub
      float hub=smoothstep(.10,.085,d);
      vec2 e=abs(f);float frame=smoothstep(.482,.492,max(e.x,e.y));                                      // the chassis between fans
      float screw=smoothstep(.02,.012,length(e-vec2(.44)));
      float heat=.10+.9*load;
      vec3 green=vec3(0.,.78,.02),lime=vec3(.70,1.,.22);
      vec3 col=vec3(.006,.014,.009);
      col+=green*blades*(.10+.62*heat);
      col+=mix(green,lime,load)*ring*(.22+.7*heat);
      col+=green*hub*(.05+.25*heat)+lime*hub*smoothstep(.03,.0,d)*heat;                                   // a status light in the hub
      col+=vec3(.02,.06,.03)*frame+green*screw*.25;
      col+=green*load*load*.05*smoothstep(.5,.0,d);                                                       // glow under a loaded fan
      gl_FragColor=vec4(col,1.);}`));
  gl.linkProgram(pr); gl.useProgram(pr);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const uR = gl.getUniformLocation(pr, 'r'), uM = gl.getUniformLocation(pr, 'm'), uT = gl.getUniformLocation(pr, 't');
  let mx = 0.75, my = 0.5, tx = 0.75, ty = 0.5, seen = true, last = 0; const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const size = () => { const d = Math.min(devicePixelRatio || 1, 1.5), w = Math.round(cv.clientWidth * d), hh = Math.round(cv.clientHeight * d); if (cv.width !== w || cv.height !== hh) { cv.width = w; cv.height = hh; gl.viewport(0, 0, w, hh); } };
  addEventListener('pointermove', (e) => { const b = cv.getBoundingClientRect(); tx = (e.clientX - b.left) / b.width; ty = 1 - (e.clientY - b.top) / b.height; }, { passive: true });
  new IntersectionObserver(([e]) => { seen = e.isIntersecting; }).observe(cv);
  const draw = (now) => { requestAnimationFrame(draw); if (!seen || now - last < 30) return; last = now; size();
    if (!matchMedia('(pointer: fine)').matches) { tx = 0.7 + Math.cos(now / 2600) * 0.22; ty = 0.5 + Math.sin(now / 3400) * 0.28; }
    mx += (tx - mx) * 0.07; my += (ty - my) * 0.07; gl.uniform2f(uR, cv.width, cv.height); gl.uniform2f(uM, mx, my); gl.uniform1f(uT, still ? 3 : now / 1000); gl.drawArrays(gl.TRIANGLES, 0, 3); };
  requestAnimationFrame(draw);
} else cv.style.background = 'radial-gradient(circle at 75% 50%,#0a3d12,#030604 60%)';

// ---------- reveal on scroll ----------
const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: 0.12 });
$$('.reveal').forEach((el, i) => { el.style.transitionDelay = (i % 4) * 60 + 'ms'; io.observe(el); });

// ---------- live data ----------
(async () => {
  const cfg = await nav(), rate = cfg.creditPrice || 0.7, on = (p) => p * rate;
  $('#s-credit').textContent = money(rate) + ' USDG';
  $('#mcpcmd').textContent = $('#mcpcmd').textContent.replace('https://YOUR-HOST', location.origin);
  if (cfg.token) { $('#ca').textContent = cfg.token; $('#ca').style.color = '#eafff0'; const b = $('#cabtn'); b.hidden = false; b.onclick = () => copy(cfg.token, 'Contract address copied'); }

  try { const { models } = await api('/api/v1/models'); $('#s-models').textContent = models.length;
    $('#c-out').textContent = money(on(Math.min(...models.map((m) => m.listed))), 4);
    $('#modeltable').innerHTML = models.map((m) => `<tr><td><b>${esc(m.name)}</b></td><td class="mono mute">${m.kind}</td><td class="mute">${esc(m.unit)}</td><td class="r"><span class="strike num">${money(m.listed, 3)}</span></td><td class="r num grn">${money(on(m.listed), 4)}</td></tr>`).join('');
  } catch { $('#modeltable').innerHTML = '<tr><td colspan="5" class="mute">The catalog did not load. Refresh to try again.</td></tr>'; }

  try { const { gpus } = await api('/api/v1/gpus'), open = gpus.filter((g) => g.available), cheap = open[0] || gpus[0];
    $('#s-all').textContent = gpus.length; $('#r-open').textContent = open.length + ' open'; $('#s-cheap').textContent = money(on(cheap.listed)); $('#c-gpu').textContent = money(on(cheap.listed)) + ' / hr';
    // the rack in the hero: a spread of open cards from small to large, then one busy unit if there is one
    const spread = open.filter((_, i) => i % Math.max(1, Math.floor(open.length / 5)) === 0).slice(0, 5), busy = gpus.find((g) => !g.available);
    $('#rackrows').innerHTML = [...spread, ...(busy ? [busy] : [])].map((g) => `<div class="unit ${g.available ? '' : 'busy'}"><i></i><b>${esc(g.name)}</b><span class="num mute">${g.vram} GB</span><span class="num ${g.available ? 'grn' : ''}">${g.available ? money(on(g.listed)) + ' / hr' : 'busy'}</span></div>`).join('');
    const slider = $('#vr'); slider.max = Math.max(...gpus.map((g) => g.vram));
    const paint = () => { const need = +slider.value, hit = open.find((g) => g.vram >= need); $('#need').textContent = need;
      $('#pick').textContent = hit ? hit.name : 'Nothing open'; $('#pickv').textContent = hit ? hit.vram + ' GB' : 'try less memory'; $('#pickl').textContent = hit ? money(hit.listed) : ''; $('#pickp').textContent = hit ? ' ' + money(on(hit.listed)) + ' / hr' : '';
      $('#gputable').innerHTML = gpus.map((g) => `<tr class="${g === hit ? 'hit' : ''} ${g.available ? '' : 'busy'}"><td><b>${esc(g.name)}</b>${g.available ? '' : ' <span class="pill off">busy</span>'}</td><td class="num mute">${g.vram} GB</td><td class="r"><span class="strike num">${money(g.listed)}</span></td><td class="r num">${money(on(g.listed))} / hr</td></tr>`).join('');
      const row = $('#gputable .hit'); if (row) row.parentElement.closest('.scroll').scrollTo({ top: Math.max(0, row.offsetTop - 120), behavior: 'smooth' }); };
    slider.addEventListener('input', paint); paint();
  } catch { $('#gputable').innerHTML = '<tr><td colspan="4" class="mute">The market did not load. Refresh to try again.</td></tr>'; $('#rackrows').innerHTML = '<div class="unit busy"><i></i><b>Market offline</b><span></span><span></span></div>'; }

  try { const s = await api('/api/stats'); $('#f-out').textContent = s.outputs.toLocaleString(); $('#f-sec').textContent = s.gpuSeconds.toLocaleString(); $('#f-rc').textContent = s.receipts.toLocaleString(); $('#f-hr').textContent = s.sealedHours.toLocaleString();
    const seals = await api('/api/seals'); if (seals.length) $('#seals').innerHTML = seals.slice(0, 6).map((x) => `<tr><td class="num">${x.at.slice(0, 13).replace('T', ' ')}:00</td><td class="num mute">${x.count}</td><td class="r num mute">${x.tx ? `<a href="${txUrl(esc(x.tx))}" target="_blank" rel="noopener noreferrer">${x.root.slice(0, 12)}… ↗</a>` : x.root.slice(0, 16) + '…'}</td></tr>`).join('');
  } catch { /* the numbers stay at zero */ }
})();

// ---------- the agent log, typed out when it scrolls into view ----------
const LINES = [['k', '> POST /api/v1/outputs  model=flux-schnell'], ['o', '< 402  Payment required: 0.0029 USDG on Robinhood Chain'], ['k', '> POST /api/v1/outputs  + PAYMENT-SIGNATURE'], ['o', '< signature checked, transfer submitted, gas paid by RIG'], ['k', '< 200  Output ready, receipt written']];
const term = $('#term'); let typed = false;
new IntersectionObserver(async ([e]) => { if (!e.isIntersecting || typed) return; typed = true;
  for (const [cls, text] of LINES) { const row = document.createElement('div'); row.className = cls; term.append(row); for (const ch of text) { row.textContent += ch; await new Promise((r) => setTimeout(r, 14)); } await new Promise((r) => setTimeout(r, 380)); }
  term.insertAdjacentHTML('beforeend', '<i></i>'); }, { threshold: 0.5 }).observe(term);
