(() => {
  'use strict';

  // PR の詳細画面（/owner/repo/pull/123 と、その Commits / Files changed などのタブ）で、
  // タイトルの番号（#123）の後ろに、タイトルをコピーするボタンを置く。
  // 見た目とツールチップは、GitHub のブランチ名のコピーボタンに合わせる。

  const PULL_PATH_RE = /^\/[^/]+\/[^/]+\/pull\/\d+(?:\/|$)/;
  const BUTTON_CLASS = 'ghh-copy-title';

  // PR の見出しは画面によって2種類ある。どちらも、スクロールすると出る小さい見出しではなく
  // ページ上部の大きい見出し（h1）を対象にし、ボタンは番号（#123）の後ろに置く。
  const LAYOUTS = [
    {
      // 新しい画面（Conversation など）。番号は見出しの隣の、縦中央揃えの inline-flex の中にある
      title: 'h1[data-component="PH_Title"]',
      text: '.markdown-title',
      container: (title) => {
        const suffix = title.nextElementSibling;
        return suffix && /#\d+/.test(suffix.textContent) ? suffix : title.parentElement;
      },
    },
    {
      // 従来の画面（Files changed など）。番号は見出しの中にあり、ボタンも文の流れの中に置く
      title: 'h1.gh-header-title',
      text: '.js-issue-title',
      container: (title) => title,
      inline: true,
    },
  ];
  const FEEDBACK_MS = 2000;

  // ツールチップの文言は GitHub のコピーボタン（"Copy head branch name to clipboard" / "Copied!"）に揃える
  const LABEL = 'Copy title to clipboard';
  const LABEL_COPIED = 'Copied!';
  const LABEL_FAILED = 'Copy failed';

  // GitHub の Octicons（copy-16 / check-16）と同じ形
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const ICONS = {
    copy: [
      'M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z',
      'M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z',
    ],
    check: [
      'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z',
    ],
  };

  // 設定を読むまでは出さない（オフにしている人の画面に一瞬出ないように）
  let enabled = false;

  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ICONS[name]) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  // 表示中のタイトル。インラインコードは GitHub が <code> にして表示するので、
  // 元のバッククォートを付け直す（`foo` と書いたタイトルは `foo` のままコピーされる）
  function titleText(element) {
    let text = '';
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
        else if (child.nodeName === 'CODE') text += `\`${child.textContent}\``;
        else walk(child);
      }
    };
    walk(element);
    return text.replace(/\s+/g, ' ').trim();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // クリップボード API が使えないとき（権限やフォーカスの都合）は、選択してコピーする方法に切り替える
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.top = '0';
      area.style.left = '0';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } finally {
        area.remove();
      }
      return ok;
    }
  }

  // --------------------------------------------------------------------------
  // ツールチップ
  //
  // GitHub と同じく、ボタンの 4px 下の中央に出す。popover で最前面（top layer）に出すので、
  // GitHub 側の overflow や z-index に隠されない。読み上げはボタンの aria-label が担う。
  // --------------------------------------------------------------------------

  const tooltip = { el: null, anchor: null };

  function showTooltip(anchor, text) {
    if (!tooltip.el) {
      const el = document.createElement('span');
      el.className = 'ghh-tooltip';
      el.setAttribute('popover', 'manual');
      el.setAttribute('aria-hidden', 'true');
      tooltip.el = el;
    }
    const { el } = tooltip;
    tooltip.anchor = anchor;
    el.textContent = text;
    if (!el.isConnected) document.body.appendChild(el);
    if (!el.matches(':popover-open')) el.showPopover();
    positionTooltip();
  }

  function hideTooltip() {
    const { el } = tooltip;
    tooltip.anchor = null;
    if (!el || !el.isConnected) return;
    if (el.matches(':popover-open')) el.hidePopover();
    el.remove();
  }

  function positionTooltip() {
    const { el, anchor } = tooltip;
    if (!el || !anchor) return;
    const target = anchor.getBoundingClientRect();
    const size = el.getBoundingClientRect();

    const left = Math.min(
      Math.max(8, target.left + target.width / 2 - size.width / 2),
      window.innerWidth - size.width - 8
    );
    let top = target.bottom + 4;
    // 下に収まらないときだけ上に出す
    if (top + size.height > window.innerHeight - 8) top = target.top - 4 - size.height;

    // ページ座標で置く（スクロールしてもボタンに付いてくる）
    el.style.left = `${Math.round(left + window.scrollX)}px`;
    el.style.top = `${Math.round(top + window.scrollY)}px`;
  }

  // --------------------------------------------------------------------------
  // ボタン
  // --------------------------------------------------------------------------

  function createButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.setAttribute('aria-label', LABEL);
    button.appendChild(icon('copy'));

    let hovered = false;
    let timer = 0;
    // マウスを乗せているか、キーボードで選んでいるときだけツールチップを出す
    // （クリックで付いたフォーカスでは出しっぱなしにしない）
    const wantsTooltip = () => hovered || button.matches(':focus-visible');
    const label = () => button.getAttribute('aria-label');

    const reset = () => {
      timer = 0;
      button.classList.remove('ghh-copy-title-done', 'ghh-copy-title-failed');
      button.replaceChildren(icon('copy'));
      button.setAttribute('aria-label', LABEL);
      if (wantsTooltip()) showTooltip(button, LABEL);
      else if (tooltip.anchor === button) hideTooltip();
    };

    button.addEventListener('mouseenter', () => {
      hovered = true;
      showTooltip(button, label());
    });
    button.addEventListener('mouseleave', () => {
      hovered = false;
      // コピー直後の「Copied!」は、マウスを離しても戻るまで見せる
      if (!timer && !button.matches(':focus-visible')) hideTooltip();
    });
    button.addEventListener('focus', () => {
      if (button.matches(':focus-visible')) showTooltip(button, label());
    });
    button.addEventListener('blur', () => {
      if (!hovered && !timer) hideTooltip();
    });
    button.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') hideTooltip();
    });

    button.addEventListener('click', async (event) => {
      event.preventDefault();
      // 押した時点のタイトルを読む（ページを開いたあとにタイトルが編集されることがある）
      const found = findTitle();
      if (!found) return;

      const ok = await copyText(titleText(found.text));
      // 代わりの方法でコピーしたときに外れたフォーカスを戻す
      if (!button.isConnected) return;
      button.focus({ preventScroll: true });

      clearTimeout(timer);
      button.classList.toggle('ghh-copy-title-done', ok);
      button.classList.toggle('ghh-copy-title-failed', !ok);
      if (ok) button.replaceChildren(icon('check'));
      const message = ok ? LABEL_COPIED : LABEL_FAILED;
      button.setAttribute('aria-label', message);
      showTooltip(button, message);
      timer = setTimeout(reset, FEEDBACK_MS);
    });
    return button;
  }

  function findTitle() {
    for (const layout of LAYOUTS) {
      const title = document.querySelector(layout.title);
      const text = title && title.querySelector(layout.text);
      if (text) return { layout, title, text };
    }
    return null;
  }

  function sync() {
    const found = PULL_PATH_RE.test(location.pathname) ? findTitle() : null;
    let button = document.querySelector(`.${BUTTON_CLASS}`);

    // ボタンが画面から消えたら、出ていたツールチップも消す
    if (tooltip.anchor && !tooltip.anchor.isConnected) hideTooltip();

    if (!enabled || !found) {
      if (button) {
        if (tooltip.anchor === button) hideTooltip();
        button.remove();
      }
      return;
    }

    // 番号（#123）の後ろ。GitHub が描き直したら付け直す
    const container = found.layout.container(found.title);
    if (!button) button = createButton();
    button.classList.toggle('ghh-copy-title-inline', Boolean(found.layout.inline));
    if (button.parentElement !== container) container.appendChild(button);
  }

  // PR の画面はタブの切り替えなどで遷移なしに描き直されるので、DOM の変化と履歴の移動のたびに確かめる
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
  window.addEventListener('resize', positionTooltip);

  chrome.storage.sync.get({ copyTitle: true }, (stored) => {
    if (chrome.runtime.lastError) return;
    enabled = stored.copyTitle !== false;
    schedule();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.copyTitle) return;
    enabled = changes.copyTitle.newValue !== false;
    schedule();
  });
})();
