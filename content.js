(() => {
  'use strict';

  // ==========================================================================
  // 設定
  // ==========================================================================

  const DEFAULTS = {
    enabled: true,
    preview: true, // コメント欄の隣にプレビューを出すか
    prefix: 'review',
    // キーは小文字（入力の照合用）、label は実際にバッジへ出す表記
    badges: {
      must: { label: 'must', color: 'red' },
      imo: { label: 'imo', color: 'orange' },
      nits: { label: 'nits', color: 'yellow' },
      ask: { label: 'ask', color: 'blue' },
      fyi: { label: 'FYI', color: 'green' },
      good: { label: 'good', color: 'brightgreen' },
    },
  };

  // 行頭、または英数字・. / - 以外の文字（空白や日本語）の直後に現れた /label。
  // パス（app/imo など）を誤変換しないための条件。
  const BOUNDARY = '(?:^|[^A-Za-z0-9_\\-./])';
  const TOKEN_RE = new RegExp(BOUNDARY + '\\/([A-Za-z0-9_-]+)[ \\n\\u00a0]$'); // 空白で確定
  const QUERY_RE = new RegExp(BOUNDARY + '\\/([A-Za-z0-9_-]+)$'); // 入力中（プレビュー用）

  // 本文中の shields.io バッジ Markdown
  const BADGE_MD_RE = /!\[[^\]]*\]\((https?:\/\/img\.shields\.io\/badge\/[^)\s]+)\)/g;

  // GitHub のコメント本文欄。ここに挙げたものだけプレビューを付ける
  // （それ以外の textarea でも /imo + スペースの変換自体は動く）
  const COMMENT_FIELDS = [
    'textarea[name="comment[body]"]',
    'textarea[name="issue[body]"]',
    'textarea[name="pull_request[body]"]',
    'textarea[name="pull_request_review[body]"]',
    'textarea[name="commit_comment[body]"]',
    'textarea.js-comment-field',
    'textarea[data-testid="markdown-editor"]',
    'textarea[aria-label*="comment" i]',
    'textarea[aria-label*="Markdown" i]',
    'textarea[placeholder*="comment" i]',
  ].join(',');

  // shields.io の色名 → プレビュー描画用の CSS 色
  const COLOR_HEX = {
    brightgreen: '#4c1',
    green: '#97ca00',
    yellowgreen: '#a4a61d',
    yellow: '#dfb317',
    orange: '#fe7d37',
    red: '#e05d44',
    blue: '#007ec6',
    grey: '#555',
    gray: '#555',
    lightgrey: '#9f9f9f',
    lightgray: '#9f9f9f',
    blueviolet: '#8a2be2',
    success: '#4c1',
    important: '#fe7d37',
    critical: '#e05d44',
    informational: '#007ec6',
    inactive: '#9f9f9f',
  };

  let config = DEFAULTS;
  let expanding = false;

  function normalize(stored) {
    const badges = {};
    for (const [key, value] of Object.entries(stored.badges || {})) {
      const label = String(value && value.label ? value.label : key).trim();
      const color = String((value && value.color) || value || 'lightgrey').trim();
      if (label) badges[label.toLowerCase()] = { label, color: color || 'lightgrey' };
    }
    return {
      enabled: stored.enabled !== false,
      preview: stored.preview !== false,
      prefix: String(stored.prefix || DEFAULTS.prefix).trim(),
      badges: Object.keys(badges).length ? badges : DEFAULTS.badges,
    };
  }

  function loadConfig(onReady) {
    chrome.storage.sync.get(DEFAULTS, (stored) => {
      if (chrome.runtime.lastError) return;
      config = normalize(stored);
      if (onReady) onReady();
    });
  }

  // ==========================================================================
  // バッジ
  // ==========================================================================

  // shields.io のエスケープ規則: _ -> __, - -> --, 空白 -> _
  function escapeSegment(text) {
    return encodeURIComponent(
      text.replace(/_/g, '__').replace(/-/g, '--').replace(/ /g, '_')
    );
  }

  function unescapeSegment(segment) {
    let out = '';
    for (let i = 0; i < segment.length; i += 1) {
      if (segment[i] === '_') {
        if (segment[i + 1] === '_') {
          out += '_';
          i += 1;
        } else {
          out += ' ';
        }
      } else {
        out += segment[i];
      }
    }
    try {
      return decodeURIComponent(out);
    } catch {
      return out;
    }
  }

  // "review-nits-yellow" を ["review", "nits", "yellow"] に。"--" は文字としての "-"
  function splitBadgePath(path) {
    const parts = [];
    let cur = '';
    for (let i = 0; i < path.length; i += 1) {
      if (path[i] !== '-') {
        cur += path[i];
      } else if (path[i + 1] === '-') {
        cur += '-';
        i += 1;
      } else {
        parts.push(cur);
        cur = '';
      }
    }
    parts.push(cur);
    return parts.map(unescapeSegment);
  }

  function badgeMarkdown(badge) {
    const path = [config.prefix, badge.label, badge.color].map(escapeSegment).join('-');
    return `![](https://img.shields.io/badge/${path}.svg)`;
  }

  function parseBadgeUrl(url) {
    const m = /\/badge\/([^?#]+?)(?:\.(?:svg|png|json))?(?:\?[^#]*)?$/.exec(url);
    if (!m) return null;
    const parts = splitBadgePath(m[1]);
    if (parts.length < 3) return null;
    const color = parts.pop();
    const label = parts.pop();
    return { prefix: parts.join('-'), label, color };
  }

  function cssColor(color) {
    const key = String(color).toLowerCase();
    if (COLOR_HEX[key]) return COLOR_HEX[key];
    if (/^(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color)) return `#${color}`;
    return color; // CSS の色名／関数としてそのまま使う
  }

  // 入力の大文字小文字は問わず、設定に登録された表記でバッジを作る
  function findBadge(typed) {
    return config.badges[typed.toLowerCase()] || null;
  }

  function findMatches(query) {
    const q = query.toLowerCase();
    return Object.keys(config.badges)
      .filter((key) => key.startsWith(q))
      .sort()
      .map((key) => config.badges[key]);
  }

  // shields.io の flat スタイルを模した見た目を DOM で作る
  // （GitHub の CSP で img.shields.io を直接読めないため画像は使わない）
  function renderBadge(badge, prefix) {
    const wrap = document.createElement('span');
    wrap.className = 'grb-badge';

    const left = document.createElement('span');
    left.className = 'grb-badge-left';
    left.textContent = prefix != null ? prefix : config.prefix;

    const right = document.createElement('span');
    right.className = 'grb-badge-right';
    right.textContent = badge.label;
    // CSSOM 経由の指定はページの CSP の影響を受けない
    right.style.backgroundColor = cssColor(badge.color);

    wrap.append(left, right);
    return wrap;
  }

  // プレビュー内のバッジ1個
  function createChip(badge, markdown, prefix) {
    const chip = document.createElement('span');
    chip.className = 'grb-chip';
    chip.title = markdown;
    chip.appendChild(renderBadge(badge, prefix));
    return chip;
  }

  // ==========================================================================
  // Markdown → プレビュー用の DOM
  //
  // 読むだけの表示なので、素直に見出し／リスト／コードブロックの要素を組み立てる。
  // 文字列は textContent 経由でしか入れないので、本文が HTML として解釈されることはない。
  // ==========================================================================

  // 強調の中身を再帰的に処理するので、/g 付きの1個を使い回すと lastIndex を壊し合う。
  // 走査のたびに新しいインスタンスを作る。
  const INLINE_SOURCE = [
      '!\\[[^\\]\\n]*\\]\\([^)\\s]*\\)', // 画像（バッジ含む）
      '\\[[^\\]\\n]*\\]\\([^)\\s]*\\)', // リンク
      '`[^`\\n]+`', // インラインコード
      '\\*\\*[^\\s*][^*\\n]*\\*\\*', // 太字
      '__[^\\s_][^_\\n]*__',
      '~~[^~\\n]+~~', // 打ち消し
      '\\*[^\\s*][^*\\n]*\\*', // 斜体
      '_[^\\s_][^_\\n]*_',
      'https?://[^\\s<>]+', // 生 URL
  ].join('|');

  const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
  const FENCE_RE = /^\s*(```|~~~)(.*)$/;
  const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
  const QUOTE_RE = /^\s*>\s?/;
  const HR_RE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
  const TASK_RE = /^\[([ xX])\]\s+(.*)$/;

  function indentWidth(text) {
    return text.replace(/\t/g, '  ').length;
  }

  function isBlockStart(line) {
    return (
      HEADING_RE.test(line) ||
      FENCE_RE.test(line) ||
      QUOTE_RE.test(line) ||
      HR_RE.test(line) ||
      LIST_RE.test(line)
    );
  }

  function inlineElement(token) {
    if (token.startsWith('![') || token.startsWith('[')) {
      const image = token.startsWith('![');
      const split = token.indexOf('](');
      const label = token.slice(image ? 2 : 1, split);
      const url = token.slice(split + 2, token.length - 1);

      if (image) {
        const badge = /^https?:\/\/img\.shields\.io\/badge\//.test(url) ? parseBadgeUrl(url) : null;
        if (badge) return createChip({ label: badge.label, color: badge.color }, token, badge.prefix);
        // バッジ以外の画像は GitHub の CSP で読み込めないので、代わりに名前を出す
        const span = document.createElement('span');
        span.className = 'grb-md-image';
        span.textContent = `🖼 ${label || url}`;
        span.title = url;
        return span;
      }

      const link = document.createElement('a');
      link.textContent = label || url;
      if (/^https?:\/\//.test(url)) {
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
      return link;
    }

    if (token.startsWith('`')) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      return code;
    }
    if (token.startsWith('**') || token.startsWith('__')) {
      const strong = document.createElement('strong');
      renderInlineText(token.slice(2, -2), strong);
      return strong;
    }
    if (token.startsWith('~~')) {
      const del = document.createElement('del');
      renderInlineText(token.slice(2, -2), del);
      return del;
    }
    if (token.startsWith('*') || token.startsWith('_')) {
      const em = document.createElement('em');
      renderInlineText(token.slice(1, -1), em);
      return em;
    }

    const link = document.createElement('a');
    link.href = token;
    link.textContent = token;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }

  function renderInlineText(text, parent) {
    const re = new RegExp(INLINE_SOURCE, 'g');
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      parent.appendChild(inlineElement(m[0]));
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  // 段落内の改行は <br>（GitHub のコメントと同じ扱い）
  function renderInline(text, parent) {
    text.split('\n').forEach((line, i) => {
      if (i) parent.appendChild(document.createElement('br'));
      renderInlineText(line, parent);
    });
  }

  function renderList(lines, start) {
    const first = LIST_RE.exec(lines[start]);
    const base = indentWidth(first[1]);
    const ordered = /\d/.test(first[2]);
    const list = document.createElement(ordered ? 'ol' : 'ul');
    let i = start;

    while (i < lines.length) {
      const m = LIST_RE.exec(lines[i]);
      if (!m) break;

      const indent = indentWidth(m[1]);
      if (indent < base) break;

      if (indent >= base + 2 && list.lastElementChild) {
        const [child, next] = renderList(lines, i);
        list.lastElementChild.appendChild(child);
        i = next;
        continue;
      }
      if (/\d/.test(m[2]) !== ordered) break;

      const item = document.createElement('li');
      let content = m[3];
      const task = TASK_RE.exec(content);
      if (task) {
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.disabled = true;
        box.checked = /[xX]/.test(task[1]);
        item.classList.add('grb-md-task');
        item.appendChild(box);
        content = task[2];
      }
      renderInline(content, item);
      list.appendChild(item);
      i += 1;
    }
    return [list, i];
  }

  function renderMarkdown(source) {
    const frag = document.createDocumentFragment();
    const lines = source.split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) {
        i += 1;
        continue;
      }

      const fence = FENCE_RE.exec(line);
      if (fence) {
        const closing = new RegExp(`^\\s*${fence[1]}`);
        const body = [];
        i += 1;
        while (i < lines.length && !closing.test(lines[i])) body.push(lines[i++]);
        if (i < lines.length) i += 1; // 閉じフェンス
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        if (fence[2].trim()) code.dataset.lang = fence[2].trim();
        code.textContent = body.join('\n');
        pre.appendChild(code);
        frag.appendChild(pre);
        continue;
      }

      const heading = HEADING_RE.exec(line);
      if (heading) {
        const el = document.createElement(`h${heading[1].length}`);
        renderInline(heading[2], el);
        frag.appendChild(el);
        i += 1;
        continue;
      }

      if (HR_RE.test(line)) {
        frag.appendChild(document.createElement('hr'));
        i += 1;
        continue;
      }

      if (QUOTE_RE.test(line)) {
        const body = [];
        while (i < lines.length && (QUOTE_RE.test(lines[i]) || (lines[i].trim() && body.length))) {
          if (!QUOTE_RE.test(lines[i])) break;
          body.push(lines[i].replace(QUOTE_RE, ''));
          i += 1;
        }
        const quote = document.createElement('blockquote');
        quote.appendChild(renderMarkdown(body.join('\n')));
        frag.appendChild(quote);
        continue;
      }

      if (LIST_RE.test(line)) {
        const [list, next] = renderList(lines, i);
        frag.appendChild(list);
        i = next;
        continue;
      }

      const paragraph = [];
      while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) {
        paragraph.push(lines[i]);
        i += 1;
      }
      const p = document.createElement('p');
      renderInline(paragraph.join('\n'), p);
      frag.appendChild(p);
    }

    return frag;
  }

  // ==========================================================================
  // プレビュー欄（Write の隣に並べる）
  // ==========================================================================

  const panes = new Map(); // textarea -> state
  const collapsedFields = new WeakSet(); // 手動で隠した欄（付け直しても隠したままにする）
  const SIDE_MIN_CONTAINER = 700; // これより狭い場所では横に並べない
  const SIDE_MIN_PANE = 280; // 並べた結果これより細くなるなら下に積む

  function attachPreview(textarea) {
    if (panes.has(textarea)) return panes.get(textarea);

    const pane = document.createElement('div');
    pane.className = 'grb-preview';

    const head = document.createElement('div');
    head.className = 'grb-preview-head';

    const title = document.createElement('span');
    title.textContent = 'Preview';

    // 入力欄の上に重ねると本文を隠すので、プレビューの見出しに置く
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'grb-preview-toggle';

    head.append(title, toggle);

    const body = document.createElement('div');
    body.className = 'grb-preview-body';

    pane.append(head, body);
    textarea.insertAdjacentElement('afterend', pane);

    const state = {
      textarea,
      pane,
      body,
      toggle,
      collapsed: false,
      value: null,
      frame: 0,
      check: 0,
      observer: null,
    };
    panes.set(textarea, state);
    bindPreview(state);
    setCollapsed(state, collapsedFields.has(textarea));
    return state;
  }

  // 隠しても見出しの帯は残し、そこから出し直せるようにする
  function setCollapsed(state, collapsed) {
    state.collapsed = collapsed;
    if (collapsed) collapsedFields.add(state.textarea);
    else collapsedFields.delete(state.textarea);

    state.pane.classList.toggle('grb-collapsed', collapsed);
    state.toggle.textContent = collapsed ? '出す' : '隠す';
    state.toggle.setAttribute('aria-expanded', String(!collapsed));
    update(state);
    layout(state);
  }

  function detachPreview(state) {
    if (!panes.has(state.textarea)) return;
    panes.delete(state.textarea);
    if (state.observer) state.observer.disconnect();
    if (state.frame) cancelAnimationFrame(state.frame);
    if (state.check) cancelAnimationFrame(state.check);
    const parent = state.textarea.parentElement;
    if (parent) parent.classList.remove('grb-wrap-parent');
    state.pane.remove();
    state.textarea.classList.remove('grb-split');
  }

  function update(state) {
    if (state.collapsed) return; // 出し直したときに描く
    const value = state.textarea.value;
    if (value === state.value) return;
    state.value = value;

    state.body.textContent = '';
    if (value.trim()) {
      state.body.classList.remove('grb-preview-empty');
      state.body.appendChild(renderMarkdown(value));
    } else {
      state.body.classList.add('grb-preview-empty');
      state.body.textContent = 'Nothing to preview';
    }
  }

  function scheduleUpdate(state) {
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      update(state);
      matchHeight(state);
      syncScroll(state);
    });
  }

  // 入力欄のスクロール位置に合わせてプレビューも動かす（書いている辺りが見えるように）
  function syncScroll(state) {
    if (!state.pane.classList.contains('grb-side')) return;
    const source = state.textarea;
    const sourceMax = source.scrollHeight - source.clientHeight;
    const targetMax = state.body.scrollHeight - state.body.clientHeight;
    if (targetMax <= 0) return;
    state.body.scrollTop = Math.round(targetMax * (sourceMax > 0 ? source.scrollTop / sourceMax : 0));
  }

  // 横並びのときだけ、入力欄の高さにプレビューを合わせる
  function matchHeight(state) {
    if (!state.pane.classList.contains('grb-side')) {
      state.pane.style.height = '';
      return;
    }
    const height = state.textarea.getBoundingClientRect().height;
    if (height) state.pane.style.height = `${Math.round(height)}px`;
  }

  function applySide(state, side) {
    state.textarea.classList.toggle('grb-split', side);
    state.pane.classList.toggle('grb-side', side);
    state.pane.classList.toggle('grb-stack', !side);

    const parent = state.textarea.parentElement;
    if (parent) {
      // 親が横並びの flex だと、そのままでは下に回り込めない
      const flexParent = window.getComputedStyle(parent).display.includes('flex');
      parent.classList.toggle('grb-wrap-parent', !side && flexParent);
    }
    matchHeight(state);
  }

  // GitHub 側のレイアウト（flex / grid / 固定幅）は場所によってまちまちなので、
  // まず横並びにしてみて、実際に測って細すぎたり段が崩れていたら下に積み直す。
  function layout(state) {
    const parent = state.textarea.parentElement;
    if (!parent) return;

    // 隠している間は見出しの帯だけを下に置き、入力欄は全幅に戻す
    if (state.collapsed) return applySide(state, false);

    applySide(state, parent.clientWidth >= SIDE_MIN_CONTAINER);
    if (state.check) cancelAnimationFrame(state.check);
    state.check = requestAnimationFrame(() => {
      state.check = 0;
      verifyLayout(state);
    });
  }

  function verifyLayout(state) {
    if (!state.pane.classList.contains('grb-side')) return;

    const source = state.textarea.getBoundingClientRect();
    const pane = state.pane.getBoundingClientRect();
    const sideBySide =
      pane.width >= SIDE_MIN_PANE &&
      source.width >= SIDE_MIN_PANE &&
      pane.left >= source.right - 2 && // 本当に右隣にいるか
      Math.abs(pane.top - source.top) < 12; // 段が落ちていないか

    if (!sideBySide) applySide(state, false);
    else matchHeight(state);
  }

  function bindPreview(state) {
    const { textarea, toggle } = state;

    // mousedown を止めれば入力欄のフォーカスを保ったまま押せる
    toggle.addEventListener('mousedown', (event) => event.preventDefault());
    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      setCollapsed(state, !state.collapsed);
    });

    const onInput = () => scheduleUpdate(state);
    textarea.addEventListener('input', onInput);
    textarea.addEventListener('change', onInput);
    textarea.addEventListener('scroll', () => syncScroll(state));

    // 入力欄の高さが変わる（GitHub の autosize）のに追従する
    if (window.ResizeObserver) {
      const observer = new ResizeObserver(() => {
        matchHeight(state);
        verifyLayout(state);
      });
      observer.observe(textarea);
      state.observer = observer;
    }
  }

  function syncAllPreviews() {
    if (config.enabled && config.preview) {
      for (const textarea of document.querySelectorAll(COMMENT_FIELDS)) attachPreview(textarea);
    } else {
      for (const state of [...panes.values()]) detachPreview(state);
    }
  }

  // 下書きの復元やファイル添付など、input が飛ばない書き換えにも追いつく
  setInterval(() => {
    for (const state of panes.values()) {
      if (!state.textarea.isConnected) detachPreview(state);
      else if (state.textarea.value !== state.value) update(state);
    }
  }, 1500);

  // ==========================================================================
  // /imo の置換
  // ==========================================================================

  function replaceWithUndo(selectRange, run) {
    expanding = true;
    try {
      selectRange();
      return run();
    } finally {
      expanding = false;
    }
  }

  function replaceInTextField(el, start, end, text) {
    // execCommand は undo 履歴と React の onChange を維持できるので優先する
    const ok = replaceWithUndo(
      () => el.setSelectionRange(start, end),
      () => document.execCommand('insertText', false, text)
    );
    if (ok) return;

    const value = el.value;
    el.value = value.slice(0, start) + text + value.slice(end);
    const pos = start + text.length;
    el.setSelectionRange(pos, pos);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function selectTextNodeRange(node, start, end) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // 入力欄の種類を吸収して「カーソル直前のテキスト」と置換手段を返す
  function readContext(el) {
    if (el instanceof HTMLTextAreaElement) {
      const caret = el.selectionStart;
      if (caret == null || caret !== el.selectionEnd) return null;
      return {
        before: el.value.slice(0, caret),
        caret,
        insert: (start, end, badge, trailing) =>
          replaceInTextField(el, start, end, badgeMarkdown(badge) + trailing),
        caretRect: () => textareaCaretRect(el),
      };
    }

    if (el.isContentEditable) {
      const sel = window.getSelection();
      if (!sel || !sel.isCollapsed) return null;
      const node = sel.anchorNode;
      if (!node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return null;
      const caret = sel.anchorOffset;
      return {
        before: node.textContent.slice(0, caret),
        caret,
        insert: (start, end, badge, trailing) =>
          replaceWithUndo(
            () => selectTextNodeRange(node, start, end),
            () => document.execCommand('insertText', false, badgeMarkdown(badge) + trailing)
          ),
        caretRect: () => selectionCaretRect(el),
      };
    }

    return null;
  }
  // ==========================================================================
  // カーソル位置の座標
  // ==========================================================================

  const MIRROR_PROPS = [
    'boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth',
    'borderLeftWidth', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontFamily',
    'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent', 'textTransform',
    'whiteSpace', 'wordWrap', 'wordBreak', 'tabSize',
  ];

  // textarea にはカーソル座標を取る API がないので、同じスタイルの div に
  // 同じテキストを流し込んで測る（いわゆるミラー方式）
  function textareaCaretRect(el) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    const mirror = document.createElement('div');

    for (const prop of MIRROR_PROPS) mirror.style[prop] = style[prop];
    mirror.style.position = 'absolute';
    mirror.style.top = '0';
    mirror.style.left = '-9999px';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordWrap = 'break-word';
    mirror.style.overflow = 'hidden';

    mirror.textContent = el.value.slice(0, el.selectionStart);
    const marker = document.createElement('span');
    marker.textContent = el.value.slice(el.selectionStart) || '.';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);

    const offsetTop = marker.offsetTop;
    const offsetLeft = marker.offsetLeft;
    mirror.remove();

    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
    const top = rect.top + offsetTop - el.scrollTop;
    return { left: rect.left + offsetLeft - el.scrollLeft, top, bottom: top + lineHeight };
  }

  function selectionCaretRect(el) {
    const sel = window.getSelection();
    const fallback = el.getBoundingClientRect();
    if (!sel || sel.rangeCount === 0) return fallback;

    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect.width && !rect.height && !rect.top) return fallback;
    return { left: rect.left, top: rect.top, bottom: rect.bottom };
  }

  // ==========================================================================
  // 候補プレビュー
  // ==========================================================================

  const popup = { root: null, list: null, items: [], index: 0, target: null, range: null };

  function ensurePopup() {
    if (popup.root) return popup.root;

    const root = document.createElement('div');
    root.className = 'grb-popup';
    root.setAttribute('role', 'listbox');
    root.hidden = true;

    const list = document.createElement('div');
    list.className = 'grb-list';
    root.appendChild(list);

    const hint = document.createElement('div');
    hint.className = 'grb-hint';
    hint.textContent = 'Tab / Enter で挿入・↑↓ で選択・Esc で閉じる';
    root.appendChild(hint);

    document.body.appendChild(root);
    popup.root = root;
    popup.list = list;
    return root;
  }

  function hidePopup() {
    if (!popup.root || popup.root.hidden) return;
    popup.root.hidden = true;
    popup.items = [];
    popup.target = null;
    popup.range = null;
  }

  function highlight(index) {
    const children = popup.list.children;
    if (!children.length) return;
    popup.index = (index + children.length) % children.length;
    for (let i = 0; i < children.length; i += 1) {
      children[i].classList.toggle('grb-item-active', i === popup.index);
    }
    children[popup.index].scrollIntoView({ block: 'nearest' });
  }

  function showPopup(el, matches, range, rect) {
    const root = ensurePopup();
    popup.items = matches;
    popup.target = el;
    popup.range = range;
    popup.list.textContent = '';

    matches.forEach((badge, i) => {
      const item = document.createElement('div');
      item.className = 'grb-item';
      item.setAttribute('role', 'option');
      item.appendChild(renderBadge(badge));

      const token = document.createElement('span');
      token.className = 'grb-token';
      token.textContent = `/${badge.label}`;
      item.appendChild(token);

      // mousedown なら入力欄のフォーカスを外さずに確定できる
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        commit(badge);
      });
      item.addEventListener('mouseenter', () => highlight(i));
      popup.list.appendChild(item);
    });

    root.hidden = false;
    highlight(0);
    positionPopup(rect);
  }

  function positionPopup(rect) {
    const root = popup.root;
    root.style.top = '0px';
    root.style.left = '0px';
    const size = root.getBoundingClientRect();

    let left = rect.left;
    let top = rect.bottom + 6;
    if (left + size.width > window.innerWidth - 8) {
      left = Math.max(8, window.innerWidth - size.width - 8);
    }
    if (top + size.height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - size.height - 6);
    }
    root.style.left = `${Math.round(left)}px`;
    root.style.top = `${Math.round(top)}px`;
  }

  function commit(badge) {
    const target = popup.target;
    const range = popup.range;
    hidePopup();
    if (!target || !badge || !range) return;
    const context = readContext(target);
    if (!context) return;
    context.insert(range.start, range.end, badge, ' ');
  }

  // ==========================================================================
  // イベント
  // ==========================================================================

  function expand(context) {
    const match = TOKEN_RE.exec(context.before);
    if (!match) return false;

    const badge = findBadge(match[1]);
    if (!badge) return false;

    const whitespace = context.before.slice(context.caret - 1, context.caret); // 打たれた空白か改行
    const end = context.caret;
    const start = end - 1 - (match[1].length + 1); // "/label" の先頭
    if (start < 0) return false;

    // 空白ごと置き換えて、同じ空白を入れ直す（カーソルが必ず空白の後ろに残る）
    context.insert(start, end, badge, whitespace);
    return true;
  }

  function updatePopup(el, context) {
    const match = QUERY_RE.exec(context.before);
    if (!match) return hidePopup();

    const matches = findMatches(match[1]);
    if (!matches.length) return hidePopup();

    const end = context.caret;
    const start = end - (match[1].length + 1);
    if (start < 0) return hidePopup();

    showPopup(el, matches, { start, end }, context.caretRect());
  }

  document.addEventListener(
    'input',
    (event) => {
      if (!config.enabled || expanding) return;
      if (event.isComposing) return; // IME 変換中は触らない

      const el = event.target;
      // 変換対象はコメント本文の入力欄だけ。検索ボックスやタイトル欄（input）は触らない。
      if (!el || !(el instanceof HTMLTextAreaElement || el.isContentEditable)) return;
      const context = readContext(el);
      if (!context) return hidePopup();

      if (expand(context)) return hidePopup();
      updatePopup(el, context);
    },
    true
  );

  document.addEventListener(
    'keydown',
    (event) => {
      if (!popup.root || popup.root.hidden || event.isComposing) return;
      if (event.target !== popup.target) return hidePopup();

      const stop = () => {
        event.preventDefault();
        event.stopPropagation();
      };

      switch (event.key) {
        case 'ArrowDown':
          stop();
          return highlight(popup.index + 1);
        case 'ArrowUp':
          stop();
          return highlight(popup.index - 1);
        case 'Enter':
        case 'Tab':
          if (event.ctrlKey || event.metaKey || event.altKey) return hidePopup();
          stop();
          return commit(popup.items[popup.index]);
        case 'Escape':
          stop();
          return hidePopup();
        default:
          return undefined;
      }
    },
    true
  );

  document.addEventListener('blur', hidePopup, true);
  document.addEventListener(
    'scroll',
    (event) => {
      const target = event.target;
      // プレビューの更新で出るスクロールで候補を閉じない
      if (target && target.nodeType === 1 && target.closest && target.closest('.grb-preview')) return;

      // 入力欄そのもののスクロールなら、閉じずに位置を合わせ直す
      if (popup.target && target === popup.target) {
        const context = readContext(popup.target);
        if (context) return positionPopup(context.caretRect());
      }
      hidePopup();
    },
    true
  );
  document.addEventListener(
    'mousedown',
    (event) => {
      if (popup.root && !popup.root.contains(event.target)) hidePopup();
    },
    true
  );
  window.addEventListener('resize', () => {
    hidePopup();
    for (const state of panes.values()) layout(state);
  });

  // コメント欄は後から差し込まれるので、フォーカスと DOM 変化の両方で拾う
  document.addEventListener(
    'focusin',
    (event) => {
      const el = event.target;
      if (!(el instanceof HTMLTextAreaElement) || !el.matches(COMMENT_FIELDS)) return;
      if (!config.enabled || !config.preview) return;
      attachPreview(el);
    },
    true
  );

  let scanQueued = false;
  new MutationObserver(() => {
    if (!config.enabled || !config.preview || scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      for (const textarea of document.querySelectorAll(COMMENT_FIELDS)) attachPreview(textarea);
      for (const state of [...panes.values()]) {
        if (!state.textarea.isConnected) detachPreview(state);
        else layout(state);
      }
    });
  }).observe(document.documentElement, { childList: true, subtree: true });

  // 設定の読み込みは、下の宣言がすべて済んでから（同期で返る環境でも安全なように）
  loadConfig(() => syncAllPreviews());
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'sync') loadConfig(() => syncAllPreviews());
  });

  syncAllPreviews();
})();
