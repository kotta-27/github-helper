// 動作確認用の小さなサーバ。テストページを GitHub と同じ形の URL で開くために使う
// （拡張機能は URL のパスで動くページを決めるが、file:// ではパスを書き換えられないため）。
//
//   node test/serve.mjs
//   → http://127.0.0.1:8123/octo/repo/pulls    PR 一覧の絞り込みボタン
//   → http://127.0.0.1:8123/octo/repo/pull/1   PR タイトルのコピーボタン

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PORT) || 8123;
// GitHub の URL の形 → それを再現したテストページ
const ROUTES = [
  [/^\/[^/]+\/[^/]+\/pulls\/?$/, '/test/pr-filters.html'],
  [/^\/[^/]+\/[^/]+\/pull\/\d+(?:\/.*)?$/, '/test/copy-title.html'],
];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const route = ROUTES.find(([pattern]) => pattern.test(path));
  if (route) path = route[1];

  const file = normalize(join(root, path));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${port}/octo/repo/pulls    PR 一覧の絞り込みボタン`);
  console.log(`http://127.0.0.1:${port}/octo/repo/pull/1   PR タイトルのコピーボタン`);
});
