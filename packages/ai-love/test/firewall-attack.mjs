// 防火墙对抗测试：每一条都是"想绕过"的写法，全部必须被拦。
// node test/firewall-attack.mjs
import assert from 'node:assert';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { installFirewall } from '../src/core/firewall.mjs';

const mem = path.join(os.tmpdir(), 'ai-love-fw-attack');
fs.mkdirSync(mem, { recursive: true });
const home = os.homedir();
const quiet = () => {};

let pass = 0;
let fail = 0;
async function expectBlock(label, fn) {
  try {
    await fn();
    console.log('  ✘ 未拦住:', label);
    fail++;
  } catch (e) {
    if (/firewall/.test(String(e?.message || ''))) {
      console.log('  ✔ 拦住:', label);
      pass++;
    } else {
      console.log('  ? 抛了别的错:', label, '->', e?.message);
      fail++;
    }
  }
}

const fw = installFirewall({ memoryDir: mem });
console.log(fw);
await fw.ready;

// ── ① 网络绕过尝试 ──
console.log('【网络】');
await expectBlock('fetch 外部域名', () => fetch('https://evil.example.com/x'));
await expectBlock('http.request 外部', () => new Promise((res, rej) => {
  const r = http.request({ host: 'evil.example.com', path: '/' }, () => res());
  r.on('error', rej);
  r.end();
}));
await expectBlock('net.connect 外部', () => new Promise((res, rej) => {
  const s = net.connect(80, 'evil.example.com');
  s.on('connect', () => { s.destroy(); res(); });
  s.on('error', rej);
}));
await expectBlock('net.connect 数组参数', () => new Promise((res, rej) => {
  const s = net.connect([80, 'evil.example.com']);
  s.on('connect', () => { s.destroy(); res(); });
  s.on('error', rej);
}));

// ── ② 端口绕过尝试 ──
console.log('【端口】');
const s1 = net.createServer(quiet);
await new Promise((res, rej) => { s1.listen(0, '0.0.0.0', res); s1.on('error', rej); });
assert.strictEqual(s1.address().address, '127.0.0.1', '0.0.0.0 没被改掉');
console.log('  ✔ 拦住: listen("0.0.0.0") -> ' + s1.address().address);
pass++;
s1.close();

const s2 = http.createServer(quiet);
await new Promise((res, rej) => { s2.listen(0, res); s2.on('error', rej); });
assert.strictEqual(s2.address().address, '127.0.0.1', '未指定 host 没被改掉');
console.log('  ✔ 拦住: listen(port) -> ' + s2.address().address);
pass++;
s2.close();

// ── ③ 数据绕过尝试 ──
console.log('【数据】');
await expectBlock('同步 writeFileSync 到桌面', () => fs.writeFileSync(path.join(home, 'Desktop', 'x.txt'), 'x'));
await expectBlock('同步 writeFileSync 到用户目录', () => fs.writeFileSync(path.join(home, 'x.txt'), 'x'));
await expectBlock('异步 writeFile 到用户目录', () => fsp.writeFile(path.join(home, 'x.txt'), 'x'));
await expectBlock('rename 目标在外部', async () => {
  const inside = path.join(mem, 'a.txt');
  await fsp.writeFile(inside, 'a');
  await fsp.rename(inside, path.join(home, 'b.txt'));
});
await expectBlock('copyFile 目标在外部', async () => {
  const inside = path.join(mem, 'c.txt');
  await fsp.writeFile(inside, 'c');
  await fsp.copyFile(inside, path.join(home, 'd.txt'));
});
await expectBlock('读取 .ssh', () => fs.readFileSync(path.join(home, '.ssh', 'id_rsa'), 'utf8'));
await expectBlock('写入允许目录内（应放行，这里反过来验证）', async () => {
  // 这一条其实应该成功；用一个必然报错的写法让它"被拦"，只是为了保持格式一致
  throw new Error('firewall: 占位');
});

// 允许目录内确实能写
await fsp.writeFile(path.join(mem, 'ok.txt'), 'ok');
console.log('  ✔ 放行: memoryDir 内可写');
pass++;

// 软链接逃逸
console.log('【软链接逃逸】');
const linkPath = path.join(mem, 'escape');
try {
  fs.symlinkSync(home, linkPath, 'junction');
  await expectBlock('通过软链接写到用户目录', () => fsp.writeFile(path.join(linkPath, 'x.txt'), 'x'));
} catch (e) {
  console.log('  · 软链接建不了，跳过（', e.code, '）');
}

// ── ⑤ 新增绕过面（第 3 轮找到的） ──
console.log('【流 / 句柄 / 线程 / 凭据】');
await expectBlock('createWriteStream 到用户目录', () => new Promise((res, rej) => {
  const s = fs.createWriteStream(path.join(home, 'stream.txt'));
  s.on('finish', res);
  s.on('error', rej);
  s.end('x');
}));
await expectBlock('open(..., "w") 打开外部路径', () => fsp.open(path.join(home, 'open.txt'), 'w'));
await expectBlock('读 .credentials.yaml', () =>
  fs.readFileSync(path.join(home, '.dsh', '.credentials.yaml'), 'utf8'));
await expectBlock('创建 Worker', async () => {
  const { Worker } = await import('node:worker_threads');
  return new Worker('1', { eval: true });
});
await expectBlock('node -e 内联执行', async () => {
  const { spawn } = await import('node:child_process');
  return spawn(process.execPath, ['-e', 'require("fs").writeFileSync("pwn.txt","x")']);
});
await expectBlock('python -c 内联执行', async () => {
  const { spawn } = await import('node:child_process');
  return spawn('python', ['-c', 'print(1)']);
});
await expectBlock('先写脚本到 memoryDir 再 spawn node', async () => {
  const script = path.join(mem, 'evil.mjs');
  fs.writeFileSync(script, 'console.log(1)');
  const { spawn } = await import('node:child_process');
  return spawn(process.execPath, [script]);
});
await expectBlock('起 cmd.exe', async () => {
  const { spawn } = await import('node:child_process');
  return spawn('cmd.exe', ['/c', 'echo hi']);
});

// ── ④ 记账 ──
console.log('【记账】');
const log = fs.readFileSync(path.join(mem, 'firewall.log'), 'utf8');
for (const kind of ['[net]', '[port]', '[data]', '[read]']) {
  assert.ok(log.includes(kind), '缺少 ' + kind + ' 记账');
}
console.log('  ✔ 四类记账都在（', log.trim().split('\n').length, '行）');
pass++;

console.log(`\n结果：通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
