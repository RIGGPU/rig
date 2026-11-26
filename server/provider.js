// The GPUs behind RIG. Outputs run on Runpod Public Endpoints and rentals on Runpod Pods (REST API v2).
// One RUNPOD_API_KEY turns both on. RIG_TEST=1 swaps in a local stand-in so the test suite runs with no key.
import { deflateSync, crc32 } from 'node:zlib';
import { createHash } from 'node:crypto';

const KEY = process.env.RUNPOD_API_KEY || '', TEST = process.env.RIG_TEST === '1';
const API = process.env.RUNPOD_API || 'https://api.runpod.io/v2', RUN = process.env.RUNPOD_RUN || 'https://api.runpod.ai/v2';
const POD_IMAGE = process.env.POD_IMAGE || 'runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04';
export const MARKUP = Math.max(1.43, Number(process.env.MARKUP) || 1.5);   // listed rate = provider rate x MARKUP; a credit costs 0.70, so 1.43 is break-even
export const connected = () => TEST || !!KEY;

const SIZES = { square: [1024, 1024], wide: [1344, 768], tall: [768, 1344] }, RATIO = { square: '1:1', wide: '16:9', tall: '9:16' };
const star = (s) => SIZES[s].join('*');
// listed = credits at the listed price, per unit. cost = what the provider charges for the same unit.
export const MODELS = [
  { id: 'flux-schnell', name: 'FLUX.1 [schnell]', kind: 'image', endpoint: 'black-forest-labs-flux-1-schnell', unit: '1 megapixel', per: 'megapixel', listed: 0.004, cost: 0.0024, input: (p) => ({ prompt: p.prompt, width: SIZES[p.size][0], height: SIZES[p.size][1], num_inference_steps: 4, guidance: 1, seed: p.seed }) },
  { id: 'z-image-turbo', name: 'Z-Image Turbo', kind: 'image', endpoint: 'z-image-turbo', unit: '1 image', listed: 0.008, cost: 0.005, input: (p) => ({ prompt: p.prompt, size: star(p.size), seed: -1, output_format: 'png', enable_safety_checker: true }) },
  { id: 'p-image', name: 'P-Image', kind: 'image', endpoint: 'p-image-t2i', unit: '1 image', listed: 0.008, cost: 0.005, input: (p) => ({ prompt: p.prompt, aspect_ratio: RATIO[p.size] }) },
  { id: 'flux-dev', name: 'FLUX.1 [dev]', kind: 'image', endpoint: 'black-forest-labs-flux-1-dev', unit: '1 megapixel', per: 'megapixel', listed: 0.03, cost: 0.02, input: (p) => ({ prompt: p.prompt, width: SIZES[p.size][0], height: SIZES[p.size][1], num_inference_steps: 28, guidance: 3.5, seed: p.seed }) },
  { id: 'qwen-image', name: 'Qwen Image', kind: 'image', endpoint: 'qwen-image-t2i', unit: '1 image', listed: 0.03, cost: 0.02, input: (p) => ({ prompt: p.prompt, negative_prompt: '', size: star(p.size), seed: -1, enable_safety_checker: true }) },
  { id: 'seedream-4', name: 'Seedream 4.0', kind: 'image', endpoint: 'seedream-v4-t2i', unit: '1 image', listed: 0.04, cost: 0.027, input: (p) => ({ prompt: p.prompt, negative_prompt: '', size: star(p.size), seed: -1, enable_safety_checker: true }) },
  { id: 'wan-2-6-image', name: 'WAN 2.6 Image', kind: 'image', endpoint: 'wan-2-6-t2i', unit: '1 image', listed: 0.045, cost: 0.03, input: (p) => ({ prompt: p.prompt, size: '1024*1024', seed: -1, enable_safety_checker: true }), sizes: ['square'] },
  { id: 'pruna-video', name: 'Pruna Video', kind: 'video', endpoint: 'p-video', unit: '5 seconds', per: '5s', listed: 0.15, cost: 0.10, seconds: [5, 10], input: (p) => ({ prompt: p.prompt, duration: p.seconds, resolution: '720p', aspect_ratio: RATIO[p.size] }) },
  { id: 'wan-2-6-video', name: 'WAN 2.6 Video', kind: 'video', endpoint: 'wan-2-6-t2v', unit: '5 seconds', per: '5s', listed: 0.75, cost: 0.50, seconds: [5, 10, 15], sizes: ['wide', 'tall'], input: (p) => ({ prompt: p.prompt, duration: p.seconds, size: p.size === 'tall' ? '720*1280' : '1280*720', seed: -1, enable_prompt_expansion: false }) },
  { id: 'vidu-q3', name: 'Vidu Q3', kind: 'video', endpoint: 'vidu-q3-t2v', unit: '5 seconds', per: '5s', listed: 1.10, cost: 0.75, seconds: [5, 10], input: (p) => ({ prompt: p.prompt, style: 'general', resolution: '720p', duration: p.seconds, aspect_ratio: RATIO[p.size], movement_amplitude: 'auto', generate_audio: true, bgm: true, seed: -1 }) },
  { id: 'seedance-2-5', name: 'Seedance 2.5', kind: 'video', endpoint: 'tdq07exynr7zux', unit: '5 seconds', per: '5s', listed: 1.35, cost: 0.90, seconds: [5, 10, 15], input: (p) => ({ prompt: p.prompt, duration: p.seconds, resolution: '480p', aspect_ratio: RATIO[p.size], generate_audio: true, seed: -1 }) },
  { id: 'minimax-speech', name: 'MiniMax Speech', kind: 'voice', endpoint: 'minimax-speech-02-hd', unit: '1,000 characters', listed: 0.08, cost: 0.05, input: (p) => ({ prompt: p.prompt, voice_id: 'Wise_Woman', speed: 1, volume: 1, pitch: 0, english_normalization: false }) },
  { id: 'chatterbox-turbo', name: 'Chatterbox Turbo', kind: 'voice', endpoint: 'chatterbox-turbo', unit: '1,000 characters', listed: 0.10, cost: 0.07, input: (p) => ({ prompt: p.prompt, voice: 'lucy', format: 'wav' }) },
];
export const model = (id) => MODELS.find((m) => m.id === id);
// The price of one request in micro-credits (1 credit = 1,000,000), and the cleaned-up request.
export function priceOf(m, body) {
  const size = (m.sizes || Object.keys(SIZES)).includes(body.size) ? body.size : (m.sizes || ['square'])[0];
  const seconds = m.kind === 'video' ? (m.seconds.includes(+body.seconds) ? +body.seconds : m.seconds[0]) : 0;
  const mp = SIZES[size][0] * SIZES[size][1] / 1e6;
  const units = m.per === 'megapixel' ? mp : m.per === '5s' ? seconds / 5 : 1;
  return { micro: Math.ceil(m.listed * units * 1e6), params: { prompt: String(body.prompt || '').slice(0, m.kind === 'voice' ? 1000 : 2000), size, seconds, seed: Number.isInteger(body.seed) ? body.seed : Math.floor(Math.random() * 2 ** 31) } };
}
export const publicModels = () => MODELS.map((m) => ({ id: m.id, name: m.name, kind: m.kind, unit: m.unit, listed: m.listed, sizes: m.sizes || Object.keys(SIZES), videoSeconds: m.seconds || null }));

async function rp(url, opt = {}) {
  const r = await fetch(url, { method: opt.method || (opt.body ? 'POST' : 'GET'), headers: { authorization: 'Bearer ' + KEY, ...(opt.body ? { 'content-type': 'application/json' } : {}) }, body: opt.body ? JSON.stringify(opt.body) : undefined, signal: AbortSignal.timeout(opt.timeout || 30000) });
  const t = await r.text(); let j; try { j = t ? JSON.parse(t) : {}; } catch { j = { raw: t }; }
  if (!r.ok) throw Object.assign(new Error(j.detail || j.error || j.title || ('provider answered ' + r.status)), { status: r.status });
  return j;
}

// ---------- outputs ----------
const MIME = { image: ['image/png', 'png'], video: ['video/mp4', 'mp4'], voice: ['audio/wav', 'wav'] };
const fileUrl = (out) => { if (!out) return null; if (typeof out === 'string') return out; for (const k of ['result', 'image_url', 'video_url', 'audio_url', 'url']) if (typeof out[k] === 'string') return out[k]; if (Array.isArray(out) && out[0]) return fileUrl(out[0]); return null; };
export async function startOutput(m, params) {
  if (TEST) return { job: 'job_' + createHash('sha256').update(JSON.stringify(params) + Math.random()).digest('hex').slice(0, 16), started: Date.now() };
  if (!KEY) throw Object.assign(new Error('The GPU provider is not connected yet'), { status: 503 });
  const j = await rp(`${RUN}/${m.endpoint}/run`, { body: { input: m.input(params) } });
  if (!j.id) throw new Error('the provider did not start the job'); return { job: j.id, started: Date.now() };
}
// -> { state: 'making' } | { state: 'ready', bytes, mime, ext } | { state: 'failed', reason }
export async function readOutput(m, o) {
  if (TEST) { if (/\bFAIL\b/.test(o.params.prompt)) return { state: 'failed', reason: 'the model refused this prompt' }; if (Date.now() - o.started < (m.kind === 'video' ? 900 : 250)) return { state: 'making' }; return { state: 'ready', ...standIn(m, o.params) }; }
  const j = await rp(`${RUN}/${m.endpoint}/status/${o.job}`);
  if (j.status === 'COMPLETED') { const u = fileUrl(j.output); if (!u) return { state: 'failed', reason: 'the model returned no file' }; const r = await fetch(u, { signal: AbortSignal.timeout(120000) }); if (!r.ok) return { state: 'failed', reason: 'the file could not be fetched' }; const ct = (r.headers.get('content-type') || '').split(';')[0], [mime, ext] = MIME[m.kind]; const real = /^(image|video|audio)\//.test(ct) ? ct : mime; return { state: 'ready', bytes: Buffer.from(await r.arrayBuffer()), mime: real, ext: real.split('/')[1].replace('jpeg', 'jpg').replace('mpeg', 'mp3').replace('x-wav', 'wav') || ext }; }
  if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(j.status)) return { state: 'failed', reason: String(j.error || j.status).slice(0, 200) };
  return { state: 'making' };
}
// test stand-in files: a real PNG drawn from the prompt, a real WAV tone, and a tagged MP4 header
function png(w, h, seed) { const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const i = y * (w * 4 + 1) + 1 + x * 4, v = (Math.sin((x + seed % 97) / 9) * Math.cos((y + seed % 53) / 7) + 1) * 127; raw[i] = raw[i + 1] = raw[i + 2] = v; raw[i + 3] = 255; } }
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]), c = Buffer.alloc(4); c.writeUInt32BE(crc32(td) >>> 0); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
function wav(sec, hz) { const n = 8000 * sec, b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 8000 * 2 * Math.PI * hz) * 9000), 44 + i * 2); return b; }
function standIn(m, p) { const seed = parseInt(createHash('sha256').update(p.prompt).digest('hex').slice(0, 6), 16);
  if (m.kind === 'image') return { bytes: png(64, 64, seed), mime: 'image/png', ext: 'png' };
  if (m.kind === 'voice') return { bytes: wav(1, 220 + seed % 400), mime: 'audio/wav', ext: 'wav' };
  return { bytes: Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12), Buffer.from('rig-test:' + p.seconds + 's')]), mime: 'video/mp4', ext: 'mp4' }; }

// ---------- GPUs ----------
let gpuCache = { at: 0, list: [] };
const round = (x) => Math.ceil(x * 100) / 100;
const shape = (g) => ({ id: g.id, name: g.name, vram: g.memory, cloud: g.community && g.price.community > 0 ? 'COMMUNITY' : 'SECURE', cost: g.community && g.price.community > 0 ? g.price.community : g.price.secure, available: g.availability ? g.availability !== 'NONE' : true });
const TEST_GPUS = [['NVIDIA RTX A4500', 'RTX A4500', 20, 0.17], ['NVIDIA GeForce RTX 3090', 'RTX 3090', 24, 0.22], ['NVIDIA GeForce RTX 4090', 'RTX 4090', 24, 0.34], ['NVIDIA L40S', 'L40S', 48, 0.79], ['NVIDIA GeForce RTX 5090', 'RTX 5090', 32, 0.69], ['NVIDIA A100-SXM4-80GB', 'A100 SXM', 80, 1.39], ['NVIDIA H100 80GB HBM3', 'H100 SXM', 80, 2.69], ['NVIDIA B200', 'B200', 180, 5.98]];
export async function listGpus() {
  if (Date.now() - gpuCache.at < 120000 && gpuCache.list.length) return gpuCache.list;
  let list = [];
  try {
    if (TEST) list = TEST_GPUS.map(([id, name, vram, cost]) => ({ id, name, vram, cloud: 'COMMUNITY', cost, available: name !== 'B200' }));
    else if (KEY) list = (await rp(`${API}/catalog/gpus`)).gpus.filter((g) => g.manufacturer === 'NVIDIA').map(shape);
    else { // keyless read of the same catalog, so the marketplace shows real rates before a key is set
      const r = await fetch('https://api.runpod.io/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: '{ gpuTypes { id displayName memoryInGb secureCloud communityCloud securePrice communityPrice lowestPrice(input:{gpuCount:1}){stockStatus} } }' }), signal: AbortSignal.timeout(15000) });
      list = ((await r.json()).data?.gpuTypes || []).filter((g) => /^NVIDIA/.test(g.id)).map((g) => shape({ id: g.id, name: g.displayName, memory: g.memoryInGb, community: g.communityCloud, price: { secure: g.securePrice, community: g.communityPrice }, availability: g.lowestPrice?.stockStatus ? g.lowestPrice.stockStatus.toUpperCase() : 'NONE' }));
    }
  } catch (e) { if (gpuCache.list.length) return gpuCache.list; throw e; }
  list = list.filter((g) => g.cost > 0 && g.vram >= 16).map((g) => ({ ...g, listed: round(g.cost * MARKUP) })).sort((a, b) => a.listed - b.listed);
  gpuCache = { at: Date.now(), list }; return list;
}
// rig/auto: the cheapest open GPU with at least this much memory
export const cheapest = (list, minVram = 0) => list.filter((g) => g.available && g.vram >= minVram)[0] || null;

const pods = new Map();   // test stand-in pods
// A loadout is what the instance boots with. Each image is published by the provider and runs its own SSH server.
export const LOADOUTS = [
  { id: 'pytorch', name: 'PyTorch + Jupyter', app: 'Jupyter', port: 8888, image: POD_IMAGE, blurb: 'PyTorch, CUDA and JupyterLab. The default.' },
  { id: 'comfyui', name: 'ComfyUI', app: 'ComfyUI', port: 8188, image: 'runpod/comfyui:latest', blurb: 'Node-graph image and video workflows, ready on boot.' },
  { id: 'forge', name: 'Forge', app: 'Forge', port: 7860, image: 'runpod/forge:3.3.0', blurb: 'Stable Diffusion WebUI Forge for image generation.' },
  { id: 'bare', name: 'Bare CUDA', app: null, port: null, image: 'runpod/base:2.1.1-cuda1281-ubuntu2404', blurb: 'Ubuntu 24.04 with CUDA and nothing else. Bring your own stack.' },
];
export const loadout = (id) => LOADOUTS.find((l) => l.id === (id || 'pytorch'));
export const publicLoadouts = () => LOADOUTS.map(({ id, name, app, port, blurb }) => ({ id, name, app, port, blurb }));
const tunnel = (lo, host, port) => (lo?.port ? `ssh -N -L ${lo.port}:localhost:${lo.port} root@${host} -p ${port}` : null);
export async function startPod(gpu, name, sshKeys, lo = LOADOUTS[0]) {
  if (TEST) { const id = 'pod_' + Math.random().toString(36).slice(2, 12); pods.set(id, { at: Date.now(), gpu }); return { pod: id }; }
  if (!KEY) throw Object.assign(new Error('The GPU provider is not connected yet'), { status: 503 });
  const j = await rp(`${API}/pods`, { body: { name, image: lo.image, gpu: { id: gpu.id, count: 1 }, cloud: gpu.cloud, disk: 50, ports: lo.port ? ['22/tcp', lo.port + '/http'] : ['22/tcp'], env: { PUBLIC_KEY: sshKeys.join('\n'), JUPYTER_PASSWORD: name }, startSsh: true, startJupyter: lo.id === 'pytorch' }, timeout: 60000 });
  if (!j.id) throw new Error('the provider did not start the instance'); return { pod: j.id };
}
// -> { state: 'starting' | 'running' | 'ended' | 'failed', ssh, jupyter }
export async function readPod(id, lo = LOADOUTS[0]) {
  if (TEST) { const p = pods.get(id); if (!p) return { state: 'ended' }; if (p.gpu.name === 'RTX 5090' && Date.now() - p.at > 300) return { state: 'failed' }; return Date.now() - p.at < 300 ? { state: 'starting' } : { state: 'running', ssh: 'ssh root@203.0.113.24 -p 22041', jupyter: tunnel(lo, '203.0.113.24', 22041) }; }
  let j; try { j = await rp(`${API}/pods/${id}`); } catch (e) { if (e.status === 404) return { state: 'ended' }; throw e; }
  if (j.status === 'RUNNING' && j.ssh?.direct) { const d = j.ssh.direct; return { state: 'running', ssh: `ssh root@${d.host} -p ${d.port}`, jupyter: tunnel(lo, d.host, d.port) }; }
  if (j.status === 'ERROR') return { state: 'failed' };
  if (j.status === 'TERMINATED' || j.status === 'EXITED') return { state: 'ended' };
  return { state: 'starting' };
}
export async function endPod(id) {
  if (TEST) { pods.delete(id); return; }
  try { await rp(`${API}/pods/${id}`, { method: 'DELETE' }); } catch (e) { if (e.status !== 404) throw e; }
}
