// 第 7 轮补充：量化"防火墙本身"的开销（对比关闭数据层）
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const mem = path.join(os.tmpdir(), 'ai-love-fw-overhead');
fs.mkdirSync(mem, { recursive: true });

const mode = process.argv[2] || 'on';
if (mode === 'on') {
  const { installFirewall } = await import('../src/core/firewall.mjs');
  const fw = installFirewall({ memoryDir: mem });
  await fw.ready;
}

const N = 400;
const t1 = performance.now();
for (let i = 0; i < N; i++) await fsp.writeFile(path.join(mem, 'o' + i + '.txt'), 'x');
const ms = performance.now() - t1;
console.log(`mode=${mode} ${N} 次异步写: ${ms.toFixed(1)} ms（每次 ${(ms / N).toFixed(3)} ms）`);

for (const f of fs.readdirSync(mem)) {
  try { fs.unlinkSync(path.join(mem, f)); } catch { /* ignore */ }
}
