// バージョンを更新する（コミット前に実行）: node tools/bump-version.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const d = new Date();
const today = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
let prev = '';
try { prev = JSON.parse(readFileSync('version.json', 'utf8')).version; } catch {}
const n = prev.startsWith(today) ? Number(prev.split('-')[1] || 0) + 1 : 1;
const version = `${today}-${n}`;
writeFileSync('version.json', JSON.stringify({ version }) + '\n');
writeFileSync('js/version.js', `// 自動生成（tools/bump-version.mjs）\nexport const VERSION = '${version}';\n`);
console.log(version);
