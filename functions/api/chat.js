// Cloudflare Pages Functions: /api/chat
// Workers AI をバインド（変数名 AI）すると、タイトル画面の「クラウドAI」が使えるようになる。
// 無料プランなら料金はかからず、1日の無料枠を超えるとエラーになるだけ（ゲームはブラウザ内AIに切り替える）。
// 設定: Pages プロジェクト > 設定 > バインディング > Workers AI を追加（変数名: AI）
// 使うモデルは環境変数 AI_MODEL で変更できる（日本語が得意なモデルほど会話が自然になる）。

const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export async function onRequestGet({ env }) {
  return Response.json({ ai: !!env.AI });
}

export async function onRequestPost({ request, env }) {
  if (!env.AI) return Response.json({ error: 'AI binding not configured' }, { status: 501 });
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'bad json' }, { status: 400 }); }
  const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  if (!messages.length) return Response.json({ error: 'no messages' }, { status: 400 });
  const max_tokens = Math.min(Number(body.max_tokens) || 160, 300);
  const temperature = Math.min(Math.max(Number(body.temperature) || 0.8, 0), 1.5);
  try {
    const r = await env.AI.run(env.AI_MODEL || DEFAULT_MODEL, { messages, max_tokens, temperature });
    return Response.json({ text: r.response ?? '' });
  } catch (e) {
    const msg = String(e);
    // 無料枠（1日1万ニューロン）を使い切ると 4006 エラーになる。ゲーム側に 429 で知らせる
    const quota = /4006|neuron|allocation|quota|rate limit|limit exceeded/i.test(msg);
    return Response.json({ error: msg, quota }, { status: quota ? 429 : 500 });
  }
}
