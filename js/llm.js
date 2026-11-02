// LLMアダプタ。呼び出し口をここ1か所にまとめているので、
// ブラウザ内LLM(WebLLM) ⇔ API(Cloudflare Workers AI) ⇔ なし(テンプレ) を差し替えられる。

export const MODELS = {
  'webllm-large': { label: 'ブラウザ内AI（高品質 7B / 約5GB）', id: 'Qwen2.5-7B-Instruct-q4f16_1-MLC' },
};

// Workers AI の無料枠：1日 10,000 ニューロン（日本時間 朝9時＝UTC 0時 にリセット）
export const DAILY_NEURONS = 10000;
// 100万トークンあたりのニューロン数 [入力, 出力]（Cloudflare の料金表より）
const NEURON_RATES = {
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': [26668, 204805],
  '@cf/qwen/qwen3-30b-a3b-fp8': [4625, 30475],
  '@cf/google/gemma-4-26b-a4b-it': [9091, 27273],
  '@cf/meta/llama-3.1-8b-instruct-fp8-fast': [4119, 34868],
  '@cf/meta/llama-3.1-8b-instruct-awq': [11161, 24215],
};
const USAGE_KEY = 'nariyuki-ai-usage';
const DENSITY_KEY = 'nariyuki-ai-density';
// 住民の「考える力」（AIの濃さ）。low=控えめ normal=ふつう high=濃い
export const DENSITY = {
  low: { label: '控えめ', plans: false, chats: 0, diary: false, posts: 6 },
  normal: { label: 'ふつう', plans: true, chats: 6, diary: true, posts: 12 },
  high: { label: '濃い', plans: true, chats: 14, diary: true, posts: 20 },
};
// PCのAI（Ollama）。PCに入れた無料のAIアプリに、ブラウザから直接話しかける
export const OLLAMA_URL = 'http://localhost:11434';
export const OLLAMA_MODEL = 'gemma3:12b';
const OLLAMA_KEY = 'nariyuki-ollama-model';
const utcDay = () => new Date().toISOString().slice(0, 10);

export const LLM = {
  mode: 'none',
  ready: false,
  density: (typeof localStorage !== 'undefined' && localStorage.getItem(DENSITY_KEY)) || 'normal',
  setDensity(d) { if (DENSITY[d]) { this.density = d; try { localStorage.setItem(DENSITY_KEY, d); } catch {} } },
  // いまの濃さの設定。クラウドAIの無料枠を75%使ったら、裏方は自動で「控えめ」にして会話の分を残す
  dens() {
    if (this.mode === 'api' && this.usagePct() >= 75) return DENSITY.low;
    return DENSITY[this.density] || DENSITY.normal;
  },
  engine: null,
  pending: 0,
  ollama: { url: OLLAMA_URL, model: (typeof localStorage !== 'undefined' && localStorage.getItem(OLLAMA_KEY)) || OLLAMA_MODEL },
  setOllamaModel(m) { this.ollama.model = (m || '').trim() || OLLAMA_MODEL; try { localStorage.setItem(OLLAMA_KEY, this.ollama.model); } catch {} },
  _chain: Promise.resolve(),

  hasWebGPU() { return !!navigator.gpu; },

  async probeApi() {
    try {
      const res = await fetch('./api/chat', { method: 'GET' });
      if (!res.ok) return false;
      const j = await res.json();
      if (j.model) this.apiModel = j.model;
      if (j.light) this.lightModel = j.light;
      return !!j.ai;
    } catch { return false; }
  },

  async init(mode, onProgress = () => {}) {
    this.mode = mode;
    this.chosen = mode;          // タイトルで選んだ頭脳（無料枠切れで変わっても覚えておく）
    this.quotaOut = false;
    this.ready = false;
    if (mode === 'none') return true;
    if (mode === 'api') { this.ready = true; return true; }
    if (mode === 'ollama') { await this.connectOllama(); this.ready = true; return true; }
    await this.loadBrowser(mode, onProgress);
    this.ready = true;
    return true;
  },

  async loadBrowser(mode, onProgress) {
    const model = MODELS[mode];
    if (!model) throw new Error('unknown mode ' + mode);
    const webllm = await import('https://esm.run/@mlc-ai/web-llm');
    const opts = { initProgressCallback: (p) => onProgress(p.progress ?? 0, p.text ?? '') };
    try {
      // 別スレッドで動かす（画面がカクつきにくい）
      const worker = new Worker(new URL('./llm-worker.js', import.meta.url), { type: 'module' });
      this.engine = await webllm.CreateWebWorkerMLCEngine(worker, model.id, opts);
    } catch (e) {
      console.warn('Web Worker でのAI起動に失敗。画面と同じスレッドで動かします', e);
      this.engine = await webllm.CreateMLCEngine(model.id, opts);
    }
  },

  // PCのAI（Ollama）につながるか確かめる。だめなら理由（connect／nomodel）を投げる
  async connectOllama() {
    const want = this.ollama.model;
    let r;
    try { r = await fetch(`${this.ollama.url}/api/tags`, { cache: 'no-store' }); }
    catch { throw new Error('connect'); }
    if (!r.ok) throw new Error('connect');
    const j = await r.json().catch(() => ({}));
    const names = (j.models || []).map((m) => m.name);
    const hit = names.find((n) => n === want || n === `${want}:latest`) || names.find((n) => n.split(':')[0] === want);
    if (!hit) { const e = new Error('nomodel'); e.names = names; throw e; }
    this.ollamaModel = hit;
    // 最初の1回でAIをグラボに読み込んでおく（返事は待たない）
    fetch(`${this.ollama.url}/api/chat`, { method: 'POST', body: JSON.stringify({ model: hit, messages: [{ role: 'user', content: 'こんにちは' }], stream: false, keep_alive: '30m', options: { num_predict: 1 } }) }).catch(() => {});
    return true;
  },

  // クラウドAIの無料枠切れ → ブラウザ内AIへ切り替え（切り替え中はAIなしで動く）
  async switchToBrowser(onProgress = () => {}) {
    if (this.switching || this.mode !== 'api') return;
    this.switching = true;
    this.mode = 'none';
    try {
      if (!this.hasWebGPU()) throw new Error('WebGPUなし');
      await this.loadBrowser('webllm-large', onProgress);
      this.mode = 'webllm-large';
      this.ready = true;
      this.onSwitched?.(true);
    } catch (e) {
      console.warn('ブラウザ内AIへの切り替えに失敗', e);
      this.mode = 'none';
      this.onSwitched?.(false);
    }
    this.switching = false;
  },

  // 無料枠切れ → AIなしで続ける（スマホなど、ブラウザ内AIが使えないとき）
  fallbackNone() {
    if (this.mode !== 'api') return;
    this.mode = 'none';
    this.quotaOut = true;
    this.quotaDay = utcDay();
  },
  // 日付が変わって（日本時間 朝9時）無料枠が戻ったら、クラウドAIに戻す
  checkQuotaReset() {
    if (this.quotaOut && this.mode === 'none' && !this.switching && this.quotaDay !== utcDay()) {
      this.quotaOut = false; this.mode = 'api'; this.ready = true; this.apiFails = 0;
      return true;
    }
    return false;
  },

  // ---- 今日のクラウドAI使用量（目安） ----
  usage() {
    try {
      const u = JSON.parse(localStorage.getItem(USAGE_KEY) || 'null');
      if (u && u.day === utcDay()) return u;
    } catch {}
    return { day: utcDay(), neurons: 0, calls: 0 };
  },
  usagePct() { return Math.min(100, Math.round(this.usage().neurons / DAILY_NEURONS * 100)); },
  addUsage(messages, text, usage, model) {
    // usage が返ってこないときは、日本語1文字≒1トークンで見積もる
    const inTok = usage?.prompt_tokens ?? messages.reduce((a, m) => a + String(m.content).length + 4, 0);
    const outTok = usage?.completion_tokens ?? String(text || '').length;
    const [ri, ro] = NEURON_RATES[model || this.apiModel] || NEURON_RATES['@cf/meta/llama-3.3-70b-instruct-fp8-fast'];
    const u = this.usage();
    u.neurons += (inTok * ri + outTok * ro) / 1e6;
    u.calls += 1;
    try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)); } catch {}
  },

  available() { return this.mode !== 'none' && this.ready; },
  // 日本語を自然に書き換えられるだけの大きさがあるモデルか
  strong() { return this.available() && ['webllm-large', 'api', 'ollama'].includes(this.mode); },
  busy() { return this.pending > 2; },
  // 裏方の生成（掲示板・方針）は、AIが空いているときだけ
  idle() { return this.available() && this.pending === 0; },
  generating() { return this.pending > 0; },

  // 直列実行（エンジンは1つなので順番待ち）
  // tier: 'main'（あなたとの会話）／'light'（住民が裏で考えること。安いモデル）
  complete(messages, { maxTokens = 160, temperature = 0.8, tier = 'main' } = {}) {
    if (!this.available()) return Promise.resolve(null);
    this.pending++;
    const run = async () => {
      try {
        if (this.mode === 'api') {
          const res = await fetch('./api/chat', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages, max_tokens: maxTokens, temperature, tier }),
          });
          if (!res.ok) {
            // 429 = 今日の無料枠を使い切った。他のエラーも3回続いたら切り替える
            this.apiFails = (this.apiFails || 0) + 1;
            if (res.status === 429) { const u = this.usage(); u.neurons = Math.max(u.neurons, DAILY_NEURONS); try { localStorage.setItem(USAGE_KEY, JSON.stringify(u)); } catch {} }
            if (res.status === 429 || this.apiFails >= 3) this.onQuota?.();
            return null;
          }
          this.apiFails = 0;
          const j = await res.json();
          this.addUsage(messages, j.text, j.usage, j.model);
          return stripThink(j.text);
        }
        if (this.mode === 'ollama') {
          const body = { model: this.ollamaModel || this.ollama.model, messages, stream: false, keep_alive: '30m',
            options: { temperature, top_p: 0.9, num_predict: maxTokens, num_ctx: 4096 } };
          if (/qwen3/i.test(body.model)) body.think = false;
          const r = await fetch(`${this.ollama.url}/api/chat`, { method: 'POST', body: JSON.stringify(body) });
          if (!r.ok) throw new Error(`ollama ${r.status}`);
          const j = await r.json();
          return stripThink(j.message?.content);
        }
        const r = await this.engine.chat.completions.create({
          messages, max_tokens: maxTokens, temperature,
        });
        return stripThink(r.choices?.[0]?.message?.content);
      } catch (e) {
        console.warn('LLM error', e);
        return null;
      } finally {
        this.pending--;
      }
    };
    // クラウドAIは同時に頼める（裏方の考えごとで、会話の返事を待たせない）。ブラウザ内AI・PCのAIは1つずつ
    if (this.mode === 'api') return run();
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  },

  async completeJSON(messages, opts) {
    const text = await this.complete(messages, opts);
    return parseJSON(text);
  },
};

function stripThink(t) {
  if (t == null) return null;
  return String(t).replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export function parseJSON(text) {
  if (!text) return null;
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}
