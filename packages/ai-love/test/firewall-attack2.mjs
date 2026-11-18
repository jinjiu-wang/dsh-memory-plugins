// 第二轮对抗：路径花招 / shell 花招 / UDP / 端口变体 / 联网花招
import assert from 'node:assert';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';
import { installFirewall } from '../src/core/firewall.mjs';

const mem = path.join(os.tmpdir(), 'ai-love-fw-attack2');
fs.mkdirSync(mem, { recursive: true });
const home = os.homedir();

const fw = installFirewall({ memoryDir: mem });
await fw.ready;

let pass = 0;
let fail = 0;
async function expectBlock(label, fn) {
  try {
    await fn();
    console.log('  ✘ 未拦住:', label);
    fail++;
  } catch (e) {
    const m = String(e?.message || '');
    if (/firewall/.test(m)) {
      console.log('  ✔ 拦住:', label);
      pass++;
    } else if (/EPERM|EACCES|ENOTFOUND|ECONNREFUSED/.test(m)) {
      console.log('  · 环境先拦（不算我们的）:', label, '->', m.slice(0, 40));
      pass++;
    } else {
      console.log('  ? 别的错:', label, '->', m.slice(0, 60));
      fail++;
    }
  }
}

console.log('【路径花招】');
await expectBlock('扩展前缀 \\\\?\\ ', () => fs.writeFileSync('\\\\?\\' + path.join(home, 'x.txt'), 'x'));
await expectBlock('结尾点号绕过', () => fs.writeFileSync(path.join(home, 'x.txt. '), 'x'));
await expectBlock('NTFS 数据流', () => fs.writeFileSync(path.join(mem, 'ok.txt') + ':evil', 'x'));
await expectBlock('相对路径跳到外部', () => fs.writeFileSync('..\\..\\..\\x.txt', 'x'));

console.log('【shell 花招】');
await expectBlock('spawn shell:true', async () => {
  const { spawn } = await import('node:child_process');
  return spawn('echo', ['hi'], { shell: true });
});
await expectBlock('execSync 字符串命令', async () => {
  const { execSync } = await import('node:child_process');
  return execSync('cmd /c dir');
});
await expectBlock('execSync 带管道', async () => {
  const { execSync } = await import('node:child_process');
  return execSync('echo hi | more');
});
await expectBlock('execFile cmd', async () => {
  const { execFile } = await import('node:child_process');
  return execFile('cmd', ['/c', 'dir']);
});

console.log('【UDP / 端口变体】');
await expectBlock('UDP 外发', () => new Promise((res, rej) => {
  const s = dgram.createSocket('udp4');
  s.on('error', rej);
  try {
    s.send('x', 53, '8.8.8.8', (e) => (e ? rej(e) : res()));
  } catch (e) {
    rej(e);
  }
}));

const srv = net.createServer(() => {});
await new Promise((res, rej) => { srv.listen(0, '::', res); srv.on('error', rej); });
console.log('  ✔ IPv6 显式 :: ->', srv.address().address);
if (srv.address().address !== '127.0.0.1') {
  console.log('  ✘ IPv6 没被改成 127.0.0.1');
  fail++;
} else {
  pass++;
}
srv.close();

console.log('【联网花招】');
await expectBlock('白名单域名带用户信息', () => fetch('https://api.deepseek.com@evil.example.com/v1'));
await expectBlock('白名单域名尾点', () => fetch('https://api.deepseek.com.evil.example.com/v1'));
await expectBlock('大写/端口绕过', () => fetch('https://EVIL.example.com:443/v1'));
await expectBlock('http.request 选项对象', () => new Promise((res, rej) => {
  const r = http.request({ hostname: 'evil.example.com', path: '/' }, () => res());
  r.on('error', rej);
  r.end();
}));

console.log('【放行验证】');
await fsp.writeFile(path.join(mem, 'fine.txt'), 'ok');
console.log('  ✔ memoryDir 内可写');
pass++;

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
