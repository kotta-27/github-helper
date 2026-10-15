'use strict';

const DEFAULTS = {
  enabled: true,
  preview: true,
  prFilters: true,
  copyTitle: true,
  prefix: 'review',
  badges: {
    must: { label: 'must', color: 'red' },
    imo: { label: 'imo', color: 'orange' },
    nits: { label: 'nits', color: 'yellow' },
    ask: { label: 'ask', color: 'blue' },
    fyi: { label: 'FYI', color: 'green' },
    good: { label: 'good', color: 'brightgreen' },
  },
};

const $ = (id) => document.getElementById(id);

function escapeSegment(text) {
  return encodeURIComponent(
    text.replace(/_/g, '__').replace(/-/g, '--').replace(/ /g, '_')
  );
}

function badgeUrl(prefix, label, color) {
  const path = [prefix, label, color].map(escapeSegment).join('-');
  return `https://img.shields.io/badge/${path}.svg`;
}

function parseBadges(text) {
  const badges = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const [rawLabel, rawColor] = trimmed.split(/[,\t]/);
    const label = (rawLabel || '').trim();
    if (!label) continue;
    // 照合は小文字キー、バッジの表記は入力どおり（例: fyi と打って FYI と出す）
    badges[label.toLowerCase()] = { label, color: (rawColor || '').trim() || 'lightgrey' };
  }
  return badges;
}

function stringifyBadges(badges) {
  return Object.entries(badges)
    .map(([key, value]) => {
      const label = value && value.label ? value.label : key;
      const color = (value && value.color) || value || 'lightgrey';
      return `${label},${color}`;
    })
    .join('\n');
}

function renderPreview() {
  const prefix = $('prefix').value.trim() || DEFAULTS.prefix;
  const badges = parseBadges($('badges').value);
  $('preview').innerHTML = '';
  for (const badge of Object.values(badges)) {
    const img = document.createElement('img');
    img.src = badgeUrl(prefix, badge.label, badge.color);
    img.alt = `${prefix}-${badge.label}`;
    $('preview').appendChild(img);
  }
}

function restore() {
  chrome.storage.sync.get(DEFAULTS, (stored) => {
    $('enabled').checked = stored.enabled !== false;
    $('sidePreview').checked = stored.preview !== false;
    $('prFilters').checked = stored.prFilters !== false;
    $('copyTitle').checked = stored.copyTitle !== false;
    $('prefix').value = stored.prefix || DEFAULTS.prefix;
    const badges = Object.keys(stored.badges || {}).length ? stored.badges : DEFAULTS.badges;
    $('badges').value = stringifyBadges(badges);
    renderPreview();
  });
}

function save() {
  const badges = parseBadges($('badges').value);
  chrome.storage.sync.set(
    {
      enabled: $('enabled').checked,
      preview: $('sidePreview').checked,
      prFilters: $('prFilters').checked,
      copyTitle: $('copyTitle').checked,
      prefix: $('prefix').value.trim() || DEFAULTS.prefix,
      badges: Object.keys(badges).length ? badges : DEFAULTS.badges,
    },
    () => {
      $('status').textContent = '保存しました';
      setTimeout(() => ($('status').textContent = ''), 1500);
    }
  );
}

document.addEventListener('DOMContentLoaded', restore);
$('save').addEventListener('click', save);
$('prefix').addEventListener('input', renderPreview);
$('badges').addEventListener('input', renderPreview);
