// LLMアダプタ。呼び出し口をここ1か所にまとめているので、
// ブラウザ内LLM(WebLLM) ⇔ API(Cloudflare Workers AI) ⇔ なし(テンプレ) を差し替えられる。

export const MODELS = {
  'webllm-large': { label: 'ブラウザ内AI（高品質 7B / 約5GB）', id: 'Qwen2.5-7B-Instruct-q4f16_1-MLC' },
};

export const LLM = {
  mode: 'none',
  ready: false,
  engine: null,
  pending: 0,
  _chain: Promise.resolve(),

  hasWebGPU() { return !!navigator.gpu; },

  async probeApi() {
    try {
      const res = await fetch('./api/chat', { method: 'GET' });
      if (!res.ok) return false;
      const j = await res.json();
      return !!j.ai;
    } catch { return false; }
  },

  async init(mode, onProgress = () => {}) {
    this.mode = mode;
    this.ready = false;
    if (mode === 'none') return true;
    if (mode === 'api') { this.ready = true; return true; }
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

  available() { return this.mode !== 'none' && this.ready; },
  // 日本語を自然に書き換えられるだけの大きさがあるモデルか
  strong() { return this.available() && (this.mode === 'webllm-large' || this.mode === 'api'); },
  busy() { return this.pending > 2; },
  // 裏方の生成（掲示板・方針）は、AIが空いているときだけ
  idle() { return this.available() && this.pending === 0; },
  generating() { return this.pending > 0; },

  // 直列実行（エンジンは1つなので順番待ち）
  complete(messages, { maxTokens = 160, temperature = 0.8 } = {}) {
    if (!this.available()) return Promise.resolve(null);
    this.pending++;
    const run = async () => {
      try {
        if (this.mode === 'api') {
          const res = await fetch('./api/chat', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages, max_tokens: maxTokens, temperature }),
          });
          if (!res.ok) {
            // 429 = 今日の無料枠を使い切った。他のエラーも3回続いたら切り替える
            this.apiFails = (this.apiFails || 0) + 1;
            if (res.status === 429 || this.apiFails >= 3) this.onQuota?.();
            return null;
          }
          this.apiFails = 0;
          const j = await res.json();
          return j.text ?? null;
        }
        const r = await this.engine.chat.completions.create({
          messages, max_tokens: maxTokens, temperature,
        });
        return r.choices?.[0]?.message?.content ?? null;
      } catch (e) {
        console.warn('LLM error', e);
        return null;
      } finally {
        this.pending--;
      }
    };
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  },

  async completeJSON(messages, opts) {
    const text = await this.complete(messages, opts);
    return parseJSON(text);
  },
};

export function parseJSON(text) {
  if (!text) return null;
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}
