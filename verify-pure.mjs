#!/usr/bin/env node
// 纯功能组合包自检：只读扫描 packages/ 下两个插件包，确认没有人设数据。
//   node verify-pure.mjs
// 退出码 0 = 干净；1 = 发现问题。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACKAGES = path.join(ROOT, 'packages');

const FORBIDDEN_DIRS = new Set([
  'character',
  'roles',
  'persona',
  'presets',
  'legacy',
  'summaries',
  'guard',
  'interop',
  '.git',
  'node_modules',
  '__pycache__',
]);
const FORBIDDEN_FILES = new Set([
  '.install-state.json',
  'card.md',
  'card.meta.json',
  'behavior.jsonl',
  'history.jsonl',
  'proposals.json',
  'memory.db',
  'settings.json',
  'link.json',
  'facts.jsonl',
  'uncertain.jsonl',
  'activity.jsonl',
  'agent.cordis.yml',
]);
const FORBIDDEN_EXT = new Set(['.jsonl', '.db', '.sqlite', '.sqlite3', '.pyc']);
const SENSITIVE_KEYS = new Set([
  'memoryDir',
  'memoryBridgeDir',
  'backupDir',
  'contextLinkDir',
  'memoryBackupDir',
  'dataDir',
  'dbPath',
  'bridgeDir',
  'python',
  'ownerQQ',
]);
const TEXT_EXT = new Set([
  '.md', '.txt', '.json', '.js', '.mjs', '.cjs', '.ts', '.py', '.yml', '.yaml',
  '.html', '.css', '.svg', '.sh', '.ps1', '.toml', '.ini', '.cfg',
]);

const problems = [];
const note = (text) => problems.push(text);

function walk(dir, base = dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (FORBIDDEN_DIRS.has(entry.name)) {
        note(`${rel}/：不应该出现在纯功能包里的数据目录`);
        continue;
      }
      walk(full, base, out);
    } else if (entry.isFile()) {
      out.push({ full, rel, name: entry.name });
    }
  }
  return out;
}

function checkConfig(file, rel) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const key of SENSITIVE_KEYS) {
    const match = new RegExp(`^\\s*${key}:\\s*(.*?)\\s*$`, 'm').exec(text);
    if (match === null) continue;
    const value = match[1].replace(/^['"]|['"]$/g, '');
    if (value !== '') note(`${rel}：${key} 不是空值（${value}）`);
  }
  if (/[A-Za-z]:[\\/]/.test(text) || /\/Users\//.test(text) || /\/home\//.test(text)) {
    note(`${rel}：仍含绝对本机路径`);
  }
}

function checkPackage(dir, name) {
  if (!fs.existsSync(dir)) {
    note(`${name}：目录不存在`);
    return { files: 0, bytes: 0 };
  }
  const pkgFile = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgFile)) {
    note(`${name}：缺 package.json`);
    return { files: 0, bytes: 0 };
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  } catch (error) {
    note(`${name}：package.json 解析失败（${error.message}）`);
    return { files: 0, bytes: 0 };
  }
  if (pkg.name !== name) note(`${name}：package.json name 是 ${pkg.name}`);

  const files = walk(dir);
  let bytes = 0;
  for (const file of files) {
    const stat = fs.statSync(file.full);
    bytes += stat.size;
    if (FORBIDDEN_FILES.has(file.name)) note(`${name}/${file.rel}：不该随包分发`);
    if (FORBIDDEN_EXT.has(path.extname(file.name).toLowerCase())) {
      note(`${name}/${file.rel}：运行时数据/数据库文件不该随包分发`);
    }
    if (/^qq-chat.*\.ya?ml$/i.test(file.name) || (/\.patch\.yml$/i.test(file.name) && file.name !== 'cordis.patch.yml')) {
      note(`${name}/${file.rel}：agent preset / patch 文件不该随包分发`);
    }
    const ext = path.extname(file.name).toLowerCase();
    if (!TEXT_EXT.has(ext) || stat.size > 4 * 1024 * 1024) continue;
    let text;
    try {
      text = fs.readFileSync(file.full, 'utf8');
    } catch {
      continue;
    }
    // 通用隐私检查：不内置任何具体人名或人设内容。
    if (/C:\\Users\\(?!\.\.\.)[^\\\r\n]+/i.test(text)) note(`${name}/${file.rel}：含 Windows 用户目录路径`);
    if (/\/home\/[^/\r\n]+/.test(text)) note(`${name}/${file.rel}：含 Linux 用户目录路径`);
  }
  checkConfig(path.join(dir, 'cordis.patch.yml'), `${name}/cordis.patch.yml`);
  return { files: files.length, bytes };
}

let totalFiles = 0;
let totalBytes = 0;
for (const name of ['ai-love', 'xiaofeiyu-whale']) {
  const result = checkPackage(path.join(PACKAGES, name), name);
  totalFiles += result.files;
  totalBytes += result.bytes;
  console.log(`· ${name}: ${result.files} 个文件 / ${(result.bytes / 1024).toFixed(1)} KiB`);
}

console.log('');
if (problems.length === 0) {
  console.log(`✔ 纯净度检查通过：${totalFiles} 个文件 / ${(totalBytes / 1024).toFixed(1)} KiB，无人设数据。`);
} else {
  console.log(`✘ 发现 ${problems.length} 个问题：`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exitCode = 1;
}
