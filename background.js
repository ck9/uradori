// Uradori - service worker
// content script からの依頼を受けて OpenAI Responses API を呼ぶ。

const API_URL = 'https://api.openai.com/v1/responses';
const TIMEOUT_MS = 240000;


// ---- 出力スキーマ ----------------------------------------------------------
const STATUSES = ['正確', '誤解を招く', '誤り', '裏取り不能', '検証対象外'];

const SOURCES_SCHEMA = {
  type: 'array',
  description: '実際に参照したページ。無ければ空配列。',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'url'],
    properties: {
      title: { type: 'string', description: 'ページのタイトル(日本語でよい)' },
      url: { type: 'string', description: 'ページのURL' },
    },
  },
};

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['claims', 'overall'],
  properties: {
    claims: {
      type: 'array',
      description: '投稿を分解した検証可能な要素。最大6件。',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'status', 'explanation', 'unverifiable', 'sources'],
        properties: {
          claim: { type: 'string', description: '検証した主張。40字以内。' },
          status: { type: 'string', enum: STATUSES },
          explanation: { type: 'string', description: '2〜3文の簡潔な説明。' },
          unverifiable: {
            type: 'array',
            description: 'この情報だけでは判断できないこと。1項目1文の箇条書き。無ければ空配列。',
            items: { type: 'string' },
          },
          sources: SOURCES_SCHEMA,
        },
      },
    },
    overall: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'headline', 'explanation', 'unverifiable', 'sources'],
      properties: {
        status: { type: 'string', enum: STATUSES },
        headline: { type: 'string', description: '投稿全体の結論を1文(60字以内)で。' },
        explanation: { type: 'string', description: '2〜4文の統合結論。' },
        unverifiable: {
          type: 'array',
          description: '全体として判断できないこと。1項目1文の箇条書き。無ければ空配列。',
          items: { type: 'string' },
        },
        sources: SOURCES_SCHEMA,
      },
    },
  },
};

// ---- プロンプト ------------------------------------------------------------
function buildPrompt(t) {
  return `あなたは日本語のファクトチェッカーです。次の投稿を、Web検索で裏取りしてください。

# 手順
1. 投稿を検証可能な事実主張(要素)に分解する。複数の主張があれば必ず要素ごとに分ける。多くても6件にまとめる。
2. 各要素をWeb検索で個別に確認する。一次情報(公式発表・官公庁・当事者・主要報道)を優先する。
3. 検索結果が複数あっても、すべて同じ出所の引き写しなら裏取りできたとみなさない。
4. 断定できないときは無理に判定せず「裏取り不能」を選ぶ。速報段階では裏取り不能が正しい答えであることが多い。
5. 意見・感想・予測・冗談・主観的評価は「検証対象外」にする。

# 判定(各要素と全体に1つずつ)
正確 / 誤解を招く / 誤り / 裏取り不能 / 検証対象外

# 書き方
- claim: 投稿のどの部分かがひと目で分かる言い切りの形。40字以内。
- explanation: 2〜3文。日付・数値・出典元の名称を入れて、何が確認できて何が確認できなかったかを具体的に書く。専門用語や一般的でない用語を使う場合はわかりやすい説明を加えてください。
- unverifiable: この情報だけでは判断できないことの箇条書き。1項目1文、多くても3項目。無ければ空配列。
- sources: 実際に開いて確認したページのタイトルとURLだけを書く。URLを推測で作らない。
- overall.headline: 投稿全体の結論。読んだ人が1分で把握できる1文(60字以内)。
- 確信度・パーセンテージ・スコアの類は一切書かない。

--- 投稿 ---
投稿者: ${t.who}
投稿日時: ${t.datetime}
URL: ${t.url}
本文:
${t.main || '(本文なし)'}
${t.quoted ? `\n引用/連続する投稿:\n${t.quoted}` : ''}
${t.images && t.images.length ? `\n画像が${t.images.length}枚添付されています。画像の内容も検証対象に含めてください。` : ''}`;
}

const JSON_SHAPE = `

# 出力形式
次の形のJSONだけを出力する。前置き・見出し・コードブロックは書かない。
{"claims":[{"claim":"","status":"正確|誤解を招く|誤り|裏取り不能|検証対象外","explanation":"","unverifiable":[""],"sources":[{"title":"","url":""}]}],"overall":{"status":"正確|誤解を招く|誤り|裏取り不能|検証対象外","headline":"","explanation":"","unverifiable":[""],"sources":[{"title":"","url":""}]}}`;

// ---- API 呼び出し ----------------------------------------------------------
async function callOpenAI(tweet, model, apiKey, jsonMode) {
  const content = [{ type: 'input_text', text: buildPrompt(tweet) + (jsonMode ? JSON_SHAPE : '') }];
  for (const url of tweet.images || []) content.push({ type: 'input_image', image_url: url });

  const body = {
    model,
    input: [{ role: 'user', content }],
    text: {
      format: jsonMode
        ? { type: 'json_object' }
        : { type: 'json_schema', name: 'factcheck', strict: true, schema: SCHEMA },
      verbosity: 'low',
    },
    reasoning: { effort: 'medium', summary: 'auto' },
    tools: [
      { type: 'web_search', user_location: { type: 'approximate' }, search_context_size: 'high' },
    ],
    store: false,
    include: ['web_search_call.action.sources'],
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e && e.name === 'AbortError') throw new Error('タイムアウトしました。もう一度お試しください。');
    throw new Error('通信に失敗しました。ネットワークを確認してください。');
  }
  clearTimeout(timer);

  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`応答を解析できません (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error('APIキーが正しくありません。拡張機能の設定を確認してください。');
    if (res.status === 404) throw new Error(`モデル "${model}" を利用できません (${msg})`);
    // モデルが構造化出力に対応していない場合は、JSONモードで一度だけやり直す
    if (res.status === 400 && !jsonMode && /json_schema|text\.format|schema|structured/i.test(msg)) {
      return callOpenAI(tweet, model, apiKey, true);
    }
    throw new Error(msg);
  }
  return json;
}

// ---- 応答の読み取り --------------------------------------------------------
function readOutput(data) {
  let text = '';
  const cites = new Map();
  for (const item of data.output || []) {
    if (item.type === 'message') {
      for (const c of item.content || []) {
        if (c.type === 'output_text') {
          text += c.text;
          for (const a of c.annotations || []) {
            if (a.type === 'url_citation' && a.url) cites.set(a.url, a.title || a.url);
          }
        }
      }
    }
    const srcs = item?.action?.sources;
    if (Array.isArray(srcs)) {
      for (const s of srcs) {
        const u = typeof s === 'string' ? s : s?.url;
        if (u && !cites.has(u)) cites.set(u, (typeof s === 'object' && s?.title) || u);
      }
    }
  }
  if (!text && typeof data.output_text === 'string') text = data.output_text;
  return { text: text.trim(), cites: [...cites].map(([url, title]) => ({ url, title })) };
}

function parsePayload(text) {
  try {
    return JSON.parse(text);
  } catch {
    // ```json ... ``` などで包まれた場合の保険
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(text.slice(s, e + 1));
      } catch {
        /* noop */
      }
    }
  }
  return null;
}

// service worker が長い応答待ちの途中で止められないようにする
let keepAliveTimer = null;
let inFlight = 0;
function keepAlive(delta) {
  inFlight += delta;
  if (inFlight > 0 && !keepAliveTimer) {
    keepAliveTimer = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  } else if (inFlight <= 0 && keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    inFlight = 0;
  }
}

async function handle(msg) {
  const { tweet, model, apiKey } = msg;
  if (!apiKey) throw new Error('APIキーが未設定です。');
  keepAlive(1);
  try {
    const data = await callOpenAI(tweet, model, apiKey);
    const { text, cites } = readOutput(data);
    if (!text) throw new Error('空の応答が返りました。もう一度お試しください。');
    const payload = parsePayload(text);
    if (!payload || !Array.isArray(payload.claims) || !payload.overall) {
      throw new Error('応答の形式が想定と違いました。もう一度お試しください。');
    }
    return { ok: true, payload, cites };
  } finally {
    keepAlive(-1);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'factcheck') {
    handle(msg).then(sendResponse, (e) =>
      sendResponse({ ok: false, error: e?.message || String(e) })
    );
    return true; // 非同期応答
  }
  if (msg?.type === 'open-options') {
    if (chrome.action.openPopup) {
      chrome.action.openPopup().catch(() => {});
    }
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
