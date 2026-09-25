// Uradori - content script
// 投稿にファクトチェックボタンを足し、結果パネルを描画する
(function () {
  'use strict';

  const DEFAULT_MODEL = 'gpt-6-luna';
  const MAX_IMAGES = 3;
  const PANEL_MAX_WIDTH = 640;

  // 判定ごとの色。要素の左帯・バッジ・凡例で共通して使う。
  const STATUS = {
    '正確': [0, 152, 102],
    '誤解を招く': [198, 118, 0],
    '誤り': [226, 29, 41],
    '裏取り不能': [106, 115, 124],
    '検証対象外': [128, 136, 146],
  };
  const ORDER = ['誤り', '誤解を招く', '裏取り不能', '正確', '検証対象外'];
  const rgb = (s) => `rgb(${(STATUS[s] || STATUS['裏取り不能']).join(',')})`;
  const tint = (s) => `rgba(${(STATUS[s] || STATUS['裏取り不能']).join(',')},0.09)`;

  const ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><g><path d="M10.5 3a7.5 7.5 0 015.94 12.09l4.24 4.24-1.42 1.42-4.24-4.24A7.5 7.5 0 1110.5 3zm0 2a5.5 5.5 0 100 11 5.5 5.5 0 000-11zm2.6 2.66l1.42 1.42-4.6 4.6-2.6-2.6 1.42-1.42 1.18 1.19 3.18-3.19z"></path></g></svg>`;
  const CHEV = `<svg class="urd-chev" viewBox="0 0 24 24" aria-hidden="true"><g><path d="M12 15.5l-6-6L7.4 8l4.6 4.6L16.6 8 18 9.5l-6 6z"></path></g></svg>`;
  const EXT = `<svg class="urd-ext" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
    stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7"></path><path d="M9.5 7H17v7.5"></path></svg>`;

  const cache = new Map(); // `${url}|${model}` -> { payload, seconds }

  // ---- 設定 ---------------------------------------------------------------
  let settings = { apiKey: '', model: DEFAULT_MODEL };
  try {
    chrome.storage.local.get(['apiKey', 'model'], (v) => {
      if (chrome.runtime.lastError) return;
      settings = { apiKey: v.apiKey || '', model: v.model || DEFAULT_MODEL };
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local') return;
      if (ch.apiKey) settings.apiKey = ch.apiKey.newValue || '';
      if (ch.model) {
        settings.model = ch.model.newValue || DEFAULT_MODEL;
        // モデルを変えたらキャッシュの対応も変わるので、ボタンの表示を戻す
        document.querySelectorAll('.urd-btn').forEach((b) => {
          if (b.dataset.busy !== '1') applyBtnState(b);
        });
      }
    });
  } catch { /* 拡張機能の再読み込み直後 */ }

  function ask(msg) {
    return new Promise((resolve, reject) => {
      const dead = () => reject(new Error('拡張機能が再読み込みされました。ページを更新してください。'));
      try {
        if (!chrome.runtime?.id) return dead();
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) return /invalidated|Receiving end/.test(err.message) ? dead() : reject(new Error(err.message));
          resolve(res);
        });
      } catch { dead(); }
    });
  }

  // ---- 投稿の抽出 ---------------------------------------------------------
  function extractTweet(article) {
    const texts = [...article.querySelectorAll('[data-testid="tweetText"]')]
      .map((n) => n.innerText.trim())
      .filter(Boolean);

    const timeEl = article.querySelector('time[datetime]');
    const anchor = timeEl && timeEl.closest('a[href*="/status/"]');
    const url = anchor ? new URL(anchor.getAttribute('href'), location.origin).href : location.href;

    const nameEl = article.querySelector('[data-testid="User-Name"]');
    const who = nameEl ? nameEl.innerText.split('\n').filter(Boolean).slice(0, 2).join(' ') : '(不明)';

    const images = [...article.querySelectorAll('[data-testid="tweetPhoto"] img')]
      .map((i) => i.src)
      .filter((s) => /pbs\.twimg\.com/.test(s))
      .map((s) => s.replace(/name=[a-z0-9]+/i, 'name=large'))
      .filter((s, i, a) => a.indexOf(s) === i)
      .slice(0, MAX_IMAGES);

    return {
      main: texts[0] || '',
      quoted: texts.slice(1).join('\n---\n'),
      datetime: timeEl ? timeEl.getAttribute('datetime') : '(不明)',
      url, who, images,
    };
  }

  function hostOf(u) {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
  }

  // ---- パネル(body直下の単一レイヤー) --------------------------------------
  let panel = null, anchorBtn = null, anchorArticle = null, stopTimer = null, rafId = 0;

  function syncTheme(el) {
    const cs = getComputedStyle(document.body);
    el.style.setProperty('--urd-bg', cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs.backgroundColor : '#000');
    el.style.setProperty('--urd-fg', cs.color || '#e7e9ea');
  }

  function openPanel(btn, article) {
    closePanel();
    panel = document.createElement('div');
    panel.className = 'urd-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'ファクトチェック結果');
    syncTheme(panel);
    ['click', 'mousedown', 'mouseup', 'pointerdown', 'keydown', 'wheel', 'touchstart']
      .forEach((ev) => panel.addEventListener(ev, (e) => e.stopPropagation()));
    document.body.appendChild(panel);

    anchorBtn = btn;
    anchorArticle = article;
    btn.dataset.open = '1';

    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onOutside, true);
    return panel;
  }

  function closePanel() {
    if (stopTimer) { stopTimer(); stopTimer = null; }
    if (anchorBtn) delete anchorBtn.dataset.open;
    if (panel) panel.remove();
    panel = null; anchorBtn = null; anchorArticle = null;
    window.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
  }

  function onKey(e) { if (e.key === 'Escape') closePanel(); }
  function onOutside(e) {
    if (panel && !panel.contains(e.target) && e.target !== anchorBtn && !anchorBtn?.contains(e.target)) closePanel();
  }
  function schedule() {
    if (rafId) return;
    rafId = requestAnimationFrame(() => { rafId = 0; position(); });
  }

  function position() {
    if (!panel) return;
    if (!anchorBtn || !anchorBtn.isConnected) return closePanel();

    const b = anchorBtn.getBoundingClientRect();
    if (b.bottom < 0 || b.top > window.innerHeight) { panel.style.visibility = 'hidden'; return; }
    panel.style.visibility = 'visible';

    const base = (anchorArticle && anchorArticle.isConnected ? anchorArticle : anchorBtn).getBoundingClientRect();
    const width = Math.max(300, Math.min(base.width - 16, PANEL_MAX_WIDTH, window.innerWidth - 16));
    let left = base.left + 8;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));
    panel.style.width = width + 'px';
    panel.style.left = left + 'px';

    const h = panel.offsetHeight;
    let top = b.bottom + 8;
    if (top + h > window.innerHeight - 8) {
      const above = b.top - 8 - h;
      top = above >= 8 ? above : Math.max(8, window.innerHeight - h - 8);
    }
    panel.style.top = top + 'px';
  }

  // ---- 部品 ---------------------------------------------------------------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Web検索の引用で本文に混ざる [タイトル](URL) を、生の文字列ではなくリンクとして出す
  const MD_LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  function richText(tag, cls, text) {
    const n = el(tag, cls);
    const s = String(text);
    let last = 0;
    for (const m of s.matchAll(MD_LINK)) {
      n.appendChild(document.createTextNode(s.slice(last, m.index)));
      const a = el('a', 'urd-inline-link', m[1]);
      a.href = m[2];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = m[2];
      n.appendChild(a);
      last = m.index + m[0].length;
    }
    n.appendChild(document.createTextNode(s.slice(last)));
    return n;
  }

  function head(title, sub) {
    const h = el('div', 'urd-head');
    const t = el('span', 'urd-head-title', title);
    h.appendChild(t);
    if (sub) h.appendChild(el('span', 'urd-head-sub', sub));
    const close = el('button', 'urd-close', '閉じる');
    close.type = 'button';
    close.onclick = closePanel;
    h.appendChild(close);
    return h;
  }

  function sourceList(sources) {
    const ul = el('ul', 'urd-srcs');
    sources.forEach((s) => {
      if (!s || !s.url || !/^https?:\/\//.test(s.url)) return;
      const li = el('li');
      const a = el('a');
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = s.url;
      const main = el('span', 'urd-src-main');
      main.appendChild(el('span', 'urd-src-title', s.title && s.title !== s.url ? s.title : hostOf(s.url)));
      main.appendChild(el('span', 'urd-src-host', hostOf(s.url)));
      a.appendChild(main);
      a.insertAdjacentHTML('beforeend', EXT);
      li.appendChild(a);
      ul.appendChild(li);
    });
    return ul.children.length ? ul : null;
  }

  // 文字列でもリストでも受け取れるようにしておく
  function toList(v) {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    if (typeof v === 'string' && v.trim()) {
      return v.split(/\n+|(?<=。)(?=\S)/).map((x) => x.trim()).filter(Boolean);
    }
    return [];
  }

  // 展開部: 説明 / この情報だけでは判断できないこと / 根拠
  function detailBox(item) {
    const d = el('div', 'urd-detail');
    if (item.explanation) {
      d.appendChild(el('div', 'urd-label', '説明'));
      d.appendChild(richText('div', 'urd-text', item.explanation));
    }

    const unknowns = toList(item.unverifiable);
    if (unknowns.length) {
      d.appendChild(el('div', 'urd-label', 'この情報だけでは判断できないこと'));
      const ul = el('ul', 'urd-unknown');
      unknowns.forEach((u) => ul.appendChild(richText('li', null, u)));
      d.appendChild(ul);
    }

    const sources = (item.sources || []).filter((s) => s && /^https?:\/\//.test(s.url || ''));
    const list = sourceList(sources);
    if (list || item.status !== '検証対象外') {
      d.appendChild(el('div', 'urd-label', list ? `根拠 ${sources.length}件` : '根拠'));
      d.appendChild(list || el('div', 'urd-none', '裏取りできるページを見つけられませんでした。'));
    }
    return d;
  }

  function accordion(card, btn) {
    btn.type = 'button';
    btn.className = 'urd-card-btn';
    btn.setAttribute('aria-expanded', 'false');
    btn.onclick = () => {
      const open = card.dataset.open === '1';
      if (open) delete card.dataset.open; else card.dataset.open = '1';
      btn.setAttribute('aria-expanded', String(!open));
      position();
    };
  }

  // ---- 画面 ---------------------------------------------------------------
  function renderLoading(btn, article, startedAt, model) {
    const p = openPanel(btn, article);
    p.appendChild(head('ファクトチェック中', model));
    const box = el('div', 'urd-status');
    const b = el('b', null, '投稿を要素に分けて確認しています');
    box.appendChild(b);
    box.appendChild(document.createTextNode('Web上の一次情報や報道を探しています。通常は30秒ほどかかります。'));
    const t = el('div', 'urd-label', '経過 0秒');
    box.appendChild(t);
    p.appendChild(box);
    position();

    const timer = setInterval(() => {
      if (!t.isConnected) return clearInterval(timer);
      t.textContent = `経過 ${Math.round((Date.now() - startedAt) / 1000)}秒`;
    }, 1000);
    stopTimer = () => clearInterval(timer);
  }

  function renderResult(btn, article, payload, meta) {
    const p = panel && anchorBtn === btn ? panel : openPanel(btn, article);
    if (stopTimer) { stopTimer(); stopTimer = null; }
    p.innerHTML = '';

    const claims = Array.isArray(payload.claims) ? payload.claims : [];
    const overall = payload.overall || {};
    p.appendChild(head('ファクトチェック結果', `${claims.length}件の要素`));

    // 総合結論(1分でわかる)
    p.appendChild(el('div', 'urd-section', '結論（タップで根拠を表示）'));
    const card = el('div', 'urd-overall');
    card.style.setProperty('--c', rgb(overall.status));
    card.style.setProperty('--tint', tint(overall.status));
    const cbtn = el('button');
    accordion(card, cbtn);
    cbtn.appendChild(el('span', 'urd-badge-lg', overall.status || '判定なし'));
    const hl = el('span', 'urd-headline');
    hl.appendChild(el('span', 'urd-kicker', '1分でわかる結論'));
    hl.appendChild(document.createTextNode(overall.headline || '(結論なし)'));
    cbtn.appendChild(hl);
    cbtn.insertAdjacentHTML('beforeend', CHEV);
    card.appendChild(cbtn);
    card.appendChild(detailBox(overall));
    p.appendChild(card);

    // 要素ごとの判定。見出しの下に判定の内訳(色の凡例も兼ねる)を出す。
    if (claims.length) {
      p.appendChild(el('div', 'urd-section', '投稿の要素ごとの判定（タップで根拠を表示）'));

      const counts = new Map();
      claims.forEach((c) => counts.set(c.status, (counts.get(c.status) || 0) + 1));
      if (counts.size) {
        const tally = el('div', 'urd-tally');
        ORDER.filter((s) => counts.get(s)).forEach((s) => {
          const span = el('span');
          const dot = el('i');
          dot.style.setProperty('--c', rgb(s));
          span.appendChild(dot);
          span.appendChild(document.createTextNode(`${s} ${counts.get(s)}`));
          tally.appendChild(span);
        });
        p.appendChild(tally);
      }

      const list = el('div', 'urd-claims');
      claims.forEach((c) => {
        const item = el('div', 'urd-claim');
        item.style.setProperty('--c', rgb(c.status));
        item.style.setProperty('--tint', tint(c.status));
        const b = el('button');
        accordion(item, b);
        b.appendChild(el('span', 'urd-badge', c.status || '—'));
        b.appendChild(el('span', 'urd-claim-text', c.claim || ''));
        b.insertAdjacentHTML('beforeend', CHEV);
        item.appendChild(b);
        item.appendChild(detailBox(c));
        list.appendChild(item);
      });
      p.appendChild(list);
    }

    const foot = el('div', 'urd-foot');
    const again = el('button', 'urd-again', '再検証');
    again.type = 'button';
    again.onclick = () => {
      cache.delete(meta.key);
      runCheck(article, btn, meta.tweet, meta.model, true);
    };
    foot.appendChild(again);
    foot.appendChild(el('span', null,
      `${meta.model} / ${meta.seconds}秒${meta.cached ? ' / キャッシュ' : ''} — AIによる自動判定です。重要な判断の前に根拠リンクを確認してください。`));
    p.appendChild(foot);

    position();
  }

  function renderError(btn, article, msg, needsSetup) {
    const p = panel && anchorBtn === btn ? panel : openPanel(btn, article);
    if (stopTimer) { stopTimer(); stopTimer = null; }
    p.innerHTML = '';
    p.appendChild(head(needsSetup ? 'はじめに設定が必要です' : '確認できませんでした'));
    const box = el('div', 'urd-status');
    const b = el('b', needsSetup ? null : 'urd-err', msg);
    box.appendChild(b);
    if (needsSetup) {
      box.appendChild(document.createTextNode(
        'ブラウザ右上のツールバーにある拡張機能アイコンから、OpenAIのAPIキーを登録してください。'));
      const open = el('button', 'urd-setup', '設定を開く');
      open.type = 'button';
      open.onclick = () => ask({ type: 'open-options' }).catch(() => {});
      box.appendChild(open);
    }
    p.appendChild(box);
    position();
  }

  // ---- 実行 ---------------------------------------------------------------
  function setLabel(btn, text) {
    const t = btn.querySelector('.urd-btn-label');
    if (t) t.textContent = text;
  }

  // キャッシュ済みなら判定色のボタンにする。未検証なら既定の青に戻す。
  function applyBtnState(btn) {
    const hit = cache.get((btn.dataset.url || '') + '|' + (settings.model || DEFAULT_MODEL));
    const status = hit && hit.payload && hit.payload.overall ? hit.payload.overall.status : '';
    if (status) {
      btn.dataset.status = status;
      btn.style.setProperty('--sc', rgb(status));
      setLabel(btn, `結果を見る（${status}）`);
    } else {
      delete btn.dataset.status;
      btn.style.removeProperty('--sc');
      setLabel(btn, 'AIでファクトチェック');
    }
  }

  async function runCheck(article, btn, tweet, model, force) {
    const key = tweet.url + '|' + model;
    if (!force && cache.has(key)) {
      const c = cache.get(key);
      return renderResult(btn, article, c.payload, { seconds: c.seconds, cached: true, model, tweet, key });
    }

    btn.dataset.busy = '1';
    btn.dataset.url = tweet.url;
    setLabel(btn, '確認中…');
    const startedAt = Date.now();
    renderLoading(btn, article, startedAt, model);
    const tick = setInterval(() => {
      if (btn.dataset.busy !== '1') return clearInterval(tick);
      setLabel(btn, `確認中… ${Math.round((Date.now() - startedAt) / 1000)}秒`);
    }, 1000);

    try {
      const res = await ask({ type: 'factcheck', tweet, model, apiKey: settings.apiKey });
      if (!res) throw new Error('応答がありませんでした。');
      if (!res.ok) throw new Error(res.error || '不明なエラー');
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      cache.set(key, { payload: res.payload, seconds });
      delete btn.dataset.busy;
      applyBtnState(btn);
      if (anchorBtn === btn) {
        renderResult(btn, article, res.payload, { seconds, cached: false, model, tweet, key });
      }
    } catch (e) {
      delete btn.dataset.busy;
      applyBtnState(btn);
      if (anchorBtn === btn) renderError(btn, article, e.message || String(e));
    } finally {
      clearInterval(tick);
      delete btn.dataset.busy;
    }
  }

  function onCheck(article, btn) {
    if (btn.dataset.busy === '1') return;
    if (panel && anchorBtn === btn) return closePanel(); // 同じボタンで閉じる

    const tweet = extractTweet(article);
    if (!tweet.main && !tweet.images.length) {
      return renderError(btn, article, '本文も画像も取得できませんでした。');
    }
    if (!settings.apiKey) {
      return renderError(btn, article, 'OpenAIのAPIキーが未設定です。', true);
    }
    runCheck(article, btn, tweet, settings.model || DEFAULT_MODEL, false);
  }

  // ---- ボタンの設置 -------------------------------------------------------
  // アクションバー(返信・リポスト…)のすぐ上に、投稿の幅いっぱいの行として置く
  function mountRow(group, row) {
    let ref = group;
    let host = group.parentElement;
    for (let i = 0; i < 4 && host; i++) {
      const cs = getComputedStyle(host);
      const stacked = cs.display === 'block' ||
        (cs.display.indexOf('flex') >= 0 && cs.flexDirection === 'column');
      if (stacked) { host.insertBefore(row, ref); return; }
      ref = host;
      host = host.parentElement;
    }
    row.style.flex = '1 1 100%';
    group.appendChild(row); // 最後の手段: アクションバーの中
  }

  function injectButton(article) {
    if (article.dataset.urdReady === '1') return;
    const group = article.querySelector('div[role="group"]');
    if (!group || !group.querySelector('[data-testid="reply"]')) return;
    article.dataset.urdReady = '1';

    const row = el('div', 'urd-row');
    const btn = el('button', 'urd-btn');
    btn.type = 'button';
    btn.setAttribute('aria-label', 'この投稿をファクトチェックする');
    btn.innerHTML = ICON;
    btn.appendChild(el('span', 'urd-btn-label', 'AIでファクトチェック'));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onCheck(article, btn);
    });
    ['pointerdown', 'mousedown', 'mouseup', 'keydown'].forEach((ev) =>
      btn.addEventListener(ev, (e) => e.stopPropagation()));
    row.appendChild(btn);
    mountRow(group, row);
  }

  // articleのDOMは別の投稿に使い回されるので、URLが変わったらボタンの表示を戻す
  function syncButton(article) {
    const btn = article.querySelector('.urd-btn');
    if (!btn || btn.dataset.busy === '1') return;
    const timeEl = article.querySelector('time[datetime]');
    const link = timeEl && timeEl.closest('a[href*="/status/"]');
    const url = link ? new URL(link.getAttribute('href'), location.origin).href : location.href;
    if (btn.dataset.url === url) return;
    btn.dataset.url = url;
    applyBtnState(btn);
  }

  function scan() {
    document.querySelectorAll('article[data-testid="tweet"]').forEach((a) => {
      injectButton(a);
      syncButton(a);
    });
  }

  let pending = false;
  new MutationObserver(() => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; scan(); schedule(); });
  }).observe(document.body, { childList: true, subtree: true });

  scan();
  setInterval(scan, 2000); // SPA遷移の取りこぼし対策
})();
