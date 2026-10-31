// Cloudflare Pages Functions: /api/chat
// Workers AI をバインド（変数名 AI）すると、タイトル画面に「クラウドAI」が選べるようになる。
// 設定: Pages プロジェクト > 設定 > バインディング > Workers AI を追加（変数名: AI）

const MODEL = '@cf/meta/llama-3.1-8b-instruct';

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
    const r = await env.AI.run(MODEL, { messages, max_tokens, temperature });
    return Response.json({ text: r.response ?? '' });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
