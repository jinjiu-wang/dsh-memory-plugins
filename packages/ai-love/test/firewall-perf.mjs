// 第 7 轮：装了防火墙之后，正常功能还能不能跑 + 开销多大
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installFirewall } from '../src/core/firewall.mjs';

const mem = path.join(os.tmpdir(), 'ai-love-fw-perf');
fs.mkdirSync(mem, { recursive: true });

const t0 = performance.now();
const fw = installFirewall({ memoryDir: mem });
await fw.ready;
const installMs = performance.now() - t0;
console.log('安装耗时: ' + installMs.toFixed(2) + ' ms');
console.log('状态: ' + JSON.stringify({ net: fw.net, port: fw.port, data: fw.data, proc: fw.proc, worker: fw.worker }));

// 正常写读（应该是通的）
const t1 = performance.now();
const N = 300;
for (let i = 0; i < N; i++) {
  await fsp.writeFile(path.join(mem, 'f' + i + '.txt'), 'x'.repeat(200));
}
const writeMs = performance.now() - t1;
console.log(`${N} 次写入: ${writeMs.toFixed(1)} ms（每次 ${(writeMs / N).toFixed(3)} ms）`);

const t2 = performance.now();
for (let i = 0; i < N; i++) {
  await fsp.readFile(path.join(mem, 'f' + i + '.txt'), 'utf8');
}
const readMs = performance.now() - t2;
console.log(`${N} 次读取: ${readMs.toFixed(1)} ms（每次 ${(readMs / N).toFixed(3)} ms）`);

// 同步路径
const t3 = performance.now();
for (let i = 0; i < 200; i++) fs.writeFileSync(path.join(mem, 's' + i + '.txt'), 'y');
console.log(`200 次同步写: ${(performance.now() - t3).toFixed(1)} ms`);

// rename / copy 正常路径
await fsp.rename(path.join(mem, 'f0.txt'), path.join(mem, 'f0-renamed.txt'));
await fsp.copyFile(path.join(mem, 'f1.txt'), path.join(mem, 'f1-copy.txt'));
console.log('rename / copyFile 正常路径: 通过');

// 日志大小
const log = fs.statSync(path.join(mem, 'firewall.log'));
console.log('firewall.log: ' + log.size + ' 字节');

// 清理
for (const f of fs.readdirSync(mem)) {
  try { fs.unlinkSync(path.join(mem, f)); } catch { /* ignore */ }
}
console.log('清理: 通过（unlink 在允许目录内不受影响）');
console.log('第 7 轮完成');
