(() => {
  'use strict';

  // PR 一覧（/owner/repo/pulls）の見出しの横に、よく使う絞り込みのボタンを並べる。
  // 絞り込みは URL の q パラメータで表せるので、ボタンはただのリンクにする
  // （GitHub の画面の内部状態には触らない。新しいタブで開くこともできる）。

  const BASE_QUERY = 'is:pr state:open';
  const FILTERS = [
    { label: 'My PRs', qualifier: 'author:@me' },
    { label: 'Review requested', qualifier: 'review-requested:@me' },
    { label: 'Assigned', qualifier: 'assignee:@me' },
    { label: 'Mentioned', qualifier: 'mentions:@me' },
  ];
  const PULLS_PATH_RE = /^\/[^/]+\/[^/]+\/pulls\/?$/;
  const TITLE_SELECTOR = 'h1[data-testid="header-title"]';
  const GROUP_CLASS = 'ghh-pr-filters';

  // 設定を読むまでは出さない（オフにしている人の画面に一瞬出ないように）
  let enabled = false;

  function currentQuery() {
    return new URLSearchParams(location.search).get('q') || BASE_QUERY;
  }

  function hasQualifier(query, qualifier) {
    return query.toLowerCase().split(/\s+/).includes(qualifier.toLowerCase());
  }

  // 押すとその条件だけに絞る。選択中のものを押すと条件を外して全件に戻す
  function filterUrl(filter, active) {
    const url = new URL(location.pathname, location.origin);
    url.searchParams.set('q', active ? BASE_QUERY : `${BASE_QUERY} ${filter.qualifier}`);
    return url.href;
  }

  // @me はログインしていないと使えない
  function loggedIn() {
    const meta = document.querySelector('meta[name="user-login"]');
    return Boolean(meta && meta.content);
  }

  function render(group, query) {
    group.textContent = '';
    for (const filter of FILTERS) {
      const active = hasQualifier(query, filter.qualifier);
      const link = document.createElement('a');
      link.className = 'ghh-pr-filter';
      link.textContent = filter.label;
      link.href = filterUrl(filter, active);
      link.title = active ? `${filter.qualifier} を外す` : `${BASE_QUERY} ${filter.qualifier}`;
      if (active) link.setAttribute('aria-current', 'true');
      group.appendChild(link);
    }
    group.dataset.query = query;
  }

  function sync() {
    const title = document.querySelector(TITLE_SELECTOR);
    let group = document.querySelector(`.${GROUP_CLASS}`);

    if (!enabled || !loggedIn() || !PULLS_PATH_RE.test(location.pathname) || !title) {
      if (group) group.remove();
      return;
    }

    if (!group) {
      group = document.createElement('nav');
      group.className = GROUP_CLASS;
      group.setAttribute('aria-label', 'Quick filters');
    }
    // GitHub が見出しを描き直したら、新しい見出しの隣に付け直す
    if (title.nextElementSibling !== group) title.insertAdjacentElement('afterend', group);

    // 自分の書き換えでも MutationObserver が動くので、条件が変わったときだけ描き直す
    const query = currentQuery();
    if (group.dataset.query !== query) render(group, query);
  }

  // PR 一覧は画面遷移なしで描き直される（Open / Closed の切り替えや検索）ので、
  // DOM の変化と履歴の移動のたびに確かめる
  let queued = false;
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      sync();
    });
  }

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('popstate', schedule);

  chrome.storage.sync.get({ prFilters: true }, (stored) => {
    if (chrome.runtime.lastError) return;
    enabled = stored.prFilters !== false;
    schedule();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.prFilters) return;
    enabled = changes.prFilters.newValue !== false;
    schedule();
  });
})();
