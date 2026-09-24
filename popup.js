// Uradori - 設定画面
// 保存する値はAPIのモデルID、画面に出すのは読みやすい表記
const MODELS = [
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', tag: '低コスト・既定' },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', tag: '高精度' },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', tag: '最高性能' },
];
const DEFAULT_MODEL = 'gpt-6-luna';

const $key = document.getElementById('key');
const $peek = document.getElementById('peek');
const $models = document.getElementById('models');
const $save = document.getElementById('save');
const $status = document.getElementById('status');

MODELS.forEach((m) => {
  const label = document.createElement('label');
  label.className = 'model';
  const radio = document.createElement('input');
  radio.type = 'radio';
  radio.name = 'model';
  radio.value = m.id;
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = m.name;
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = m.tag;
  label.append(radio, name, tag);
  $models.appendChild(label);
});

function selected() {
  const r = $models.querySelector('input:checked');
  return r ? r.value : DEFAULT_MODEL;
}
function select(id) {
  const r = $models.querySelector(`input[value="${CSS.escape(id)}"]`) ||
            $models.querySelector(`input[value="${CSS.escape(DEFAULT_MODEL)}"]`);
  if (r) r.checked = true;
}

chrome.storage.local.get(['apiKey', 'model'], (v) => {
  $key.value = v.apiKey || '';
  select(v.model || DEFAULT_MODEL);
});

$peek.addEventListener('click', () => {
  const shown = $key.type === 'text';
  $key.type = shown ? 'password' : 'text';
  $peek.textContent = shown ? '表示' : '隠す';
  $peek.setAttribute('aria-label', shown ? 'キーを表示' : 'キーを隠す');
});

function flash(msg, isError) {
  $status.textContent = msg;
  if (isError) $status.dataset.err = '1'; else delete $status.dataset.err;
}

$save.addEventListener('click', () => {
  const apiKey = $key.value.trim();
  if (apiKey && !/^sk-/.test(apiKey)) {
    return flash('APIキーは sk- で始まります。確認してください。', true);
  }
  chrome.storage.local.set({ apiKey, model: selected() }, () => {
    if (chrome.runtime.lastError) return flash(chrome.runtime.lastError.message, true);
    flash(apiKey ? '保存しました' : 'キーが空のまま保存しました', !apiKey);
  });
});

// モデルを選んだだけでも即保存する
$models.addEventListener('change', () => {
  chrome.storage.local.set({ model: selected() }, () => flash('モデルを保存しました', false));
});

$key.addEventListener('keydown', (e) => { if (e.key === 'Enter') $save.click(); });
