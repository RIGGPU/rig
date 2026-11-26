import { $, $$, api, nav, esc } from '/common.js';
nav();
$$('[data-origin]').forEach((c) => { c.textContent = c.textContent.replaceAll('ORIGIN', location.origin); });
api('/api/v1/models').then(({ models }) => { $('#dmodels').innerHTML = models.map((m) => `<tr><td><b>${esc(m.name)}</b> <code>${esc(m.id)}</code></td><td>${m.kind}</td><td>${esc(m.unit)}</td><td class="r">${m.listed}</td></tr>`).join(''); }).catch(() => {});
