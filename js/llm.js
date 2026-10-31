// LLMアダプタ。呼び出し口をここ1か所にまとめているので、
// ブラウザ内LLM(WebLLM) ⇔ API(Cloudflare Workers AI) ⇔ なし(テンプレ) を差し替えられる。

export const MODELS = {
  'webllm-small': { label: 'ブラウザ内AI（軽量 1.5B / 約1GB）', id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC' },
  'webllm-std':   { label: 'ブラウザ内AI（標準 3B / 約2GB）',   id: 'Qwen2.5-3B-Instruct-q4f16_1-MLC' },
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
    const model = MODELS[mode];
    if (!model) throw new Error('unknown mode ' + mode);
    const webllm = await import('https://esm.run/@mlc-ai/web-llm');
    this.engine = await webllm.CreateMLCEngine(model.id, {
      initProgressCallback: (p) => onProgress(p.progress ?? 0, p.text ?? ''),
    });
    this.ready = true;
    return true;
  },

  available() { return this.mode !== 'none' && this.ready; },
  busy() { return this.pending > 2; },

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
          if (!res.ok) return null;
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
