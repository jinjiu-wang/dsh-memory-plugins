// 防火墙自测：三层各来一次，确认能拦住。
// 用 node 跑：node test/firewall.mjs
import assert from 'node:assert';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { installFirewall, firewallStats } from '../src/core/firewall.mjs';

const memoryDir = path.join(os.tmpdir(), 'ai-love-fw-test');
await fs.mkdir(memoryDir, { recursive: true });

const res = installFirewall({ memoryDir });
console.log('install ->', res);

// ① 网络：白名单外必须被拒
let netBlocked = false;
try {
  await fetch('https://example.com/steal');
} catch (e) {
  netBlocked = /firewall/.test(e.message);
}
assert.ok(netBlocked, '网络白名单没生效');
console.log('① 网络白名单 OK（example.com 被拒）');

// ② 端口：listen 未指定 host，必须被强制成 127.0.0.1
const server = net.createServer(() => {});
await new Promise((resolve, reject) => {
  server.listen(0, () => {
    const addr = server.address();
    resolve(addr);
  });
  server.on('error', reject);
});
const addr = server.address();
assert.strictEqual(addr.address, '127.0.0.1', '端口守卫没生效：' + addr.address);
server.close();
console.log('② 端口守卫 OK（绑定 ' + addr.address + '）');

// ③ 数据：允许目录内可写，外面必须被拒
await fs.writeFile(path.join(memoryDir, 'ok.txt'), 'fine');
let dataBlocked = false;
try {
  await fs.writeFile(path.join(os.homedir(), 'should-not-write.txt'), 'nope');
} catch (e) {
  dataBlocked = /firewall/.test(e.message);
}
assert.ok(dataBlocked, '数据边界没生效');
console.log('③ 数据边界 OK（用户目录写入被拒）');

const logFile = path.join(memoryDir, 'firewall.log');
const log = await fs.readFile(logFile, 'utf8');
assert.ok(log.includes('[net]') && log.includes('[port]'), '没记账');
console.log('④ 记账 OK：', log.trim().split('\n').slice(-3).join(' | '));

console.log('stats ->', firewallStats());
console.log('全部通过');
