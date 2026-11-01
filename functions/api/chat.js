// Cloudflare Pages Functions: /api/chat
// Workers AI をバインド（変数名 AI）すると、タイトル画面の「クラウドAI」が使えるようになる。
// 無料プランなら料金はかからず、1日の無料枠を超えるとエラーになるだけ（ゲームはブラウザ内AIかAIなしに切り替える）。
// 設定: Pages プロジェクト > 設定 > バインディング > Workers AI を追加（変数名: AI）
//
// AIは2種類を使い分けて、無料枠を節約する：
//   main  … あなたとの会話（日本語の自然さ重視）。環境変数 AI_MODEL で変更できる
//   light … 住民が裏で考えること（1日の予定・住民同士の会話・日記など）。安いモデル。環境変数 AI_MODEL_LIGHT で変更できる
// light が使えなかったときは、自動で main で答える。

const DEFAULT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const DEFAULT_LIGHT = '@cf/google/gemma-4-26b-a4b-it';

const modelFor = (env, tier) => (tier === 'light' ? env.AI_MODEL_LIGHT || DEFAULT_LIGHT : env.AI_MODEL || DEFAULT_MODEL);

export async function onRequestGet({ env }) {
  return Response.json({ ai: !!env.AI, model: modelFor(env, 'main'), light: modelFor(env, 'light') });
}

// モデルによって返事の形が違うので、文字だけ取り出す（考えている途中の <think> は消す）
function textOf(r) {
  let t = r?.response ?? r?.choices?.[0]?.message?.content ?? r?.result?.response ?? '';
  if (typeof t !== 'string') t = JSON.stringify(t);
  return t.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

const isQuota = (msg) => /4006|neuron|allocation|quota|rate limit|limit exceeded/i.test(msg);

export async function onRequestPost({ request, env }) {
  if (!env.AI) return Response.json({ error: 'AI binding not configured' }, { status: 501 });
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: 'bad json' }, { status: 400 }); }
  const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  if (!messages.length) return Response.json({ error: 'no messages' }, { status: 400 });
  const max_tokens = Math.min(Number(body.max_tokens) || 160, 900);
  const temperature = Math.min(Math.max(Number(body.temperature) || 0.8, 0), 1.5);
  const tier = body.tier === 'light' ? 'light' : 'main';
  const run = async (model) => {
    const r = await env.AI.run(model, { messages, max_tokens, temperature });
    return Response.json({ text: textOf(r), usage: r?.usage || null, model });
  };
  try {
    return await run(modelFor(env, tier));
  } catch (e) {
    const msg = String(e);
    // 無料枠（1日1万ニューロン）を使い切ると 4006 エラーになる。ゲーム側に 429 で知らせる
    if (isQuota(msg)) return Response.json({ error: msg, quota: true }, { status: 429 });
    // 安いモデルが使えなかったら、会話用のモデルで答える
    if (tier === 'light') {
      try { return await run(modelFor(env, 'main')); } catch (e2) {
        const m2 = String(e2);
        return Response.json({ error: m2, quota: isQuota(m2) }, { status: isQuota(m2) ? 429 : 500 });
      }
    }
    return Response.json({ error: msg, quota: false }, { status: 500 });
  }
}
