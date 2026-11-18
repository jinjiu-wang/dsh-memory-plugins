// 外部调用方回归：宿主/其它插件不在插件目录里的 fs 调用，不许被防火墙拖崩。
// 复刻 2026-11-02 的宿主崩溃：DSH 子进程退出时 rimraf 清临时目录 → unlink/rm 被数据层抛错 → 未捕获。
// 子进程脚本故意放在插件目录之外，因此对防火墙来说它就是"外部调用方"。
// 用 node 跑：node test/firewall-foreign.mjs
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fwUrl = pathToFileURL(path.join(here, '..', 'src', 'core', 'firewall.mjs')).href;

const work = path.join(os.tmpdir(), `ai-love-fw-foreign-${process.pid}`);
const memoryDir = path.join(work, 'memory');
// 故意找插件根目录、memoryDir、临时目录之外的地方：AppData\Local\ai-love-fw-foreign-probe
const probe = path.join(path.dirname(os.tmpdir()), `ai-love-fw-foreign-probe-${process.pid}`);
fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(probe, { recursive: true, force: true });
fs.mkdirSync(memoryDir, { recursive: true });
fs.mkdirSync(probe, { recursive: true });

const script = path.join(work, 'foreign-caller.mjs');
fs.writeFileSync(
  script,
  `import fs from 'node:fs';
import path from 'node:path';
import { installFirewall } from ${JSON.stringify(fwUrl)};

const [memoryDir, probe] = process.argv.slice(2);
installFirewall({ memoryDir });
// 宿主/其它插件视角的三个动作：建、unlink、整目录 rm -r（rimraf 用的就是它）
fs.writeFileSync(path.join(probe, 'foreign.txt'), 'ok');
fs.unlinkSync(path.join(probe, 'foreign.txt'));
fs.rmSync(probe, { recursive: true, force: true });
console.log('FOREIGN_OK');
`,
  'utf8'
);

const r = spawnSync(process.execPath, [script, memoryDir, probe], { encoding: 'utf8' });
assert.strictEqual(r.status, 0, `外部调用方被拖崩了（exit ${r.status}）：\n${r.stderr}`);
assert.ok(r.stdout.includes('FOREIGN_OK'), '外部调用方没跑到最后：' + r.stdout);
assert.ok(!/firewall/.test(r.stderr), '外部调用方收到了防火墙错误：' + r.stderr);

const log = fs.readFileSync(path.join(memoryDir, 'firewall.log'), 'utf8');
assert.ok(log.includes('foreign-allow'), '外部调用没记账 foreign-allow：\n' + log);
const lines = log.trim().split('\n').filter((l) => l.includes('foreign-allow'));
assert.ok(lines.some((l) => l.includes('unlink')) && lines.some((l) => l.includes('rm')),
  'unlink / rm 的 foreign-allow 没都记上：\n' + lines.join('\n'));

fs.rmSync(work, { recursive: true, force: true });
fs.rmSync(probe, { recursive: true, force: true });
console.log('外部调用方放行 OK：');
console.log(lines.slice(-3).join('\n'));

// 阶段 2：本插件自己的备份（fs.cp 内部再调 copyFile）不能被拦成半截空快照。
// 复刻 2026-11-02 面板「立即同步」把 <备份目录>/_raw 写空的事故。
const { BackupManager } = await import('../src/core/backup.mjs');
const { installFirewall } = await import('../src/core/firewall.mjs');
const snapMem = path.join(work, 'snap-memory');
const snapOut = path.join(probe + '-snap');
fs.rmSync(snapOut, { recursive: true, force: true });
fs.mkdirSync(path.join(snapMem, 'summaries'), { recursive: true });
fs.mkdirSync(path.join(snapMem, 'character'), { recursive: true });
fs.writeFileSync(path.join(snapMem, 'uncertain.jsonl'), '{"a":1}\n');
fs.writeFileSync(path.join(snapMem, 'summaries', 's1.jsonl'), '{"b":2}\n');
fs.writeFileSync(path.join(snapMem, 'character', 'card.md'), '# card\n');
// 本进程是插件目录里的代码：装上防火墙后备份仍要能完整落盘
installFirewall({ memoryDir: path.join(work, 'parent-memory') });
const backup = new BackupManager({ dir: snapOut });
const ok = await backup.snapshotRaw(snapMem);
assert.strictEqual(ok, true, '插件自己的备份被防火墙拦断了');
const snapFiles = [];
const walk = (d, base = '') => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(d, e.name), rel);
    else snapFiles.push(rel);
  }
};
walk(path.join(snapOut, '_raw'));
assert.deepStrictEqual(
  snapFiles.sort(),
  ['character/card.md', 'memory/summaries/s1.jsonl', 'memory/uncertain.jsonl'],
  '备份快照不完整：' + snapFiles.join(', ')
);
try { fs.rmSync(snapOut, { recursive: true, force: true }); } catch { /* 根外清理会被本插件守卫拦，忽略 */ }
fs.rmSync(work, { recursive: true, force: true });
console.log('插件自有备份（内部 cp）OK：_raw 快照 3 个文件完整');
console.log('全部通过');
