/**
 * ai-love · 三层防火墙 v2
 *
 * ① 网络：fetch / http(s).request / net.connect / dgram 全部走域名白名单
 * ② 端口：任何 listen 强制绑 127.0.0.1（不许 0.0.0.0 / ::）
 * ③ 数据：写操作（同步+异步）只允许在安全根目录内；重命名/复制的**目标**也要检查；
 *          解析真实路径（防软链接逃逸）；读取敏感目录（.ssh/.aws/浏览器/桌面/文档/下载）直接拒绝
 * ④ 进程：禁止起 shell（cmd/powershell/bash/sh/curl/certutil…），允许 node/python
 *
 * 关某一层：AI_LOVE_FW_NET=0 / PORT=0 / DATA=0 / PROC=0
 * 记账：<memoryDir>/firewall.log
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import os from 'node:os';
import path from 'node:path';

const S = {
  installed: false,
  allowHosts: new Set(),
  allowCmds: new Set(['node', 'node.exe', 'python', 'python.exe', 'python3']),
  writeRoots: [],
  readDeny: [],
  logFile: '',
  counts: { net: 0, port: 0, data: 0, read: 0, proc: 0 },
};

function record(kind, message) {
  S.counts[kind] = (S.counts[kind] || 0) + 1;
  try {
    if (S.logFile) fs.appendFileSync(S.logFile, `${new Date().toISOString()} [${kind}] ${message}\n`, 'utf8');
  } catch {
    /* 记账失败不影响主流程 */
  }
}

const on = (name) => {
  const v = process.env[name];
  return v === undefined || v === '' ? true : !['0', 'false', 'off', 'no'].includes(String(v).toLowerCase());
};

/**
 * 规范路径：
 *  - 去掉 Windows 扩展前缀 \\?\ 和 \\.\
 *  - 统一分隔符、小写
 *  - 去掉结尾的点/空格（Windows 会忽略，能让 "x. " 绕过比较）
 *  - 拒绝 NTFS 数据流写法（file.txt:evil）
 */
function norm(p) {
  let s = String(p || '');
  s = s.replace(/^\\\\\?\\/, '').replace(/^\\\\\.\\/, '');
  s = path.resolve(s);
  s = s.replace(/\\/g, '/');
  s = s.replace(/[. ]+$/, '');            // 结尾的点/空格
  return s.toLowerCase();
}

/** 是否带 NTFS 数据流/奇怪冒号（C:/ 之后又出现冒号） */
function hasAds(p) {
  const s = String(p || '').replace(/^[A-Za-z]:/, '');
  return s.includes(':');
}

/** 解析软链接：文件存在就 realpath 整体，否则 realpath 父目录 + basename */
function realish(p) {
  const abs = path.resolve(String(p));
  try {
    return fs.realpathSync(abs);           // 文件/目录存在：整体解析，防"文件软链接"逃逸
  } catch {
    try {
      const dir = fs.realpathSync(path.dirname(abs));
      return path.join(dir, path.basename(abs));
    } catch {
      return abs;
    }
  }
}

function inRoots(p, roots) {
  const t = norm(realish(p));
  return roots.some((r) => t === r || t.startsWith(r + '/'));
}

/**
 * 违规分支才调用：这次调用是不是本插件自己发起的。
 *
 * 防火墙是宿主进程里的全局补丁，fs / 网络 / 子进程都不分调用方。若越界就一律抛错，
 * 宿主和其他插件（清理临时目录、写 PID、登录取用户信息）会被拖崩 —— 2026-11-02
 * 的 crash-…-host.log 就是 DSH 在子进程退出时 rm 临时目录被数据层拦成未捕获异常。
 *
 * 拦截范围不变（writeRoots / readDeny / allowHosts / 命令黑名单一个字没动），
 * 只按「直接调用方」判定：本插件直接调用照旧硬拦；宿主、别的插件、以及 Node 内部
 * 实现（fs.cp 内部再去调 copyFile 这种二次调用）记 foreign-allow 后放行。
 * 只看紧贴守卫的第一帧，异步栈里的间接帧不算 —— 否则 fs.cp 复制到一半被拦，
 * 调用方把异常吞掉，会静默产出一个空快照（2026-11-02 的 _raw 就是这么空的）。
 */
function fromOwnCode() {
  if (!S.packageRoot) return true;
  let stack = '';
  try {
    stack = new Error().stack || '';
  } catch {
    return true;
  }
  const root = S.packageRoot; // norm() 之后：正斜杠、小写
  const selfFile = root + '/src/core/firewall.mjs';
  for (const line of stack.split('\n').slice(1, 12)) {
    const s = String(line).replace(/\\/g, '/').toLowerCase().replace(/%20/g, ' ');
    if (s.includes(selfFile)) continue; // 跳过守卫自身，别误伤同名的 test/firewall.mjs
    if (s.includes('node:internal/')) return false; // Node 内部实现，不是插件直接调用
    return s.includes(root + '/');
  }
  return true;
}

function hostAllowed(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return true; // 没有 host（本地 socket 等）
  if (S.allowHosts.has(h)) return true;
  for (const a of S.allowHosts) {
    if (a.startsWith('*.') && (h === a.slice(2) || h.endsWith(a.slice(1)))) return true;
  }
  return false;
}

/* ── ① 网络 ───────────────────────────────────────── */
function guardFetch() {
  const orig = globalThis.fetch;
  if (typeof orig !== 'function') return false;
  globalThis.fetch = async function guarded(input, init) {
    try {
      const url = typeof input === 'string' ? input : String(input?.url || '');
      const host = new URL(url).hostname;
      if (!hostAllowed(host)) {
        if (fromOwnCode()) {
          record('net', `fetch blocked -> ${url.slice(0, 160)}`);
          throw new Error(`ai-love firewall: 拒绝出站请求（${host}）`);
        }
        record('net', `fetch foreign-allow -> ${url.slice(0, 160)}`);
      }
    } catch (e) {
      if (String(e?.message || '').includes('firewall')) throw e;
    }
    return orig.call(this, input, init);
  };
  return true;
}

function guardHttp(mod, label) {
  const orig = mod.request;
  if (typeof orig !== 'function' || orig.__fw) return false;
  const wrapped = function guardedRequest(...args) {
    let host = '';
    try {
      const a = args[0];
      if (typeof a === 'string' || a instanceof URL) host = new URL(String(a)).hostname;
      else if (a && typeof a === 'object') host = String(a.hostname || a.host || '');
    } catch {
      host = '';
    }
    if (host && !hostAllowed(host)) {
      if (fromOwnCode()) {
        record('net', `${label}.request blocked -> ${host}`);
        throw new Error(`ai-love firewall: 拒绝出站请求（${host}）`);
      }
      record('net', `${label}.request foreign-allow -> ${host}`);
    }
    return orig.apply(this, args);
  };
  wrapped.__fw = true;
  mod.request = wrapped;
  return true;
}

function guardNetConnect() {
  let changed = false;

  // 直接把 net.connect / net.createConnection 也包一层：
  // 只打 Socket.prototype 补丁没用——net.connect() 内部不走它
  for (const name of ['connect', 'createConnection']) {
    const orig = net[name];
    if (typeof orig !== 'function' || orig.__fw) continue;
    const wrapped = function guardedConnect(...args) {
      let host = '';
      try {
        const a = args[0];
        if (Array.isArray(a)) host = String(a[1] || '');
        else if (a && typeof a === 'object') host = String(a.host || a.hostname || '');
        else if (typeof a === 'number') host = String(args[1] || '');
        else host = '';
      } catch {
        host = '';
      }
      if (host && !isLoopback(host) && !hostAllowed(host)) {
        if (fromOwnCode()) {
          record('net', `net.${name} blocked -> ${host}`);
          throw new Error(`ai-love firewall: 拒绝连接（${host}）`);
        }
        record('net', `net.${name} foreign-allow -> ${host}`);
      }
      return orig.apply(this, args);
    };
    wrapped.__fw = true;
    net[name] = wrapped;
    changed = true;
  }

  const protoOrig = net.Socket.prototype.connect;
  if (typeof protoOrig === 'function' && !protoOrig.__fw) {
    const wrapped = function guardedConnect(...args) {
      let host = '';
      try {
        const a = args[0];
        if (Array.isArray(a)) host = String(a[1] || '');
        else if (a && typeof a === 'object') host = String(a.host || a.hostname || '');
        else if (typeof a === 'number') host = String(args[1] || '');
      } catch {
        host = '';
      }
      if (host && !isLoopback(host) && !hostAllowed(host)) {
        if (fromOwnCode()) {
          record('net', `socket.connect blocked -> ${host}`);
          throw new Error(`ai-love firewall: 拒绝连接（${host}）`);
        }
        record('net', `socket.connect foreign-allow -> ${host}`);
      }
      return protoOrig.apply(this, args);
    };
    wrapped.__fw = true;
    net.Socket.prototype.connect = wrapped;
    changed = true;
  }
  return changed;
}

function isLoopback(h) {
  const s = String(h || '').toLowerCase();
  return s === '127.0.0.1' || s === 'localhost' || s === '::1' || s === '[::1]';
}

function guardDgram() {
  const orig = dgram.createSocket;
  if (orig.__fw) return false;
  const wrapped = function guardedCreateSocket(...args) {
    record('net', 'dgram socket 创建（本地 UDP；外部发送会被拒）');
    const sock = orig.apply(this, args);
    try {
      const send = sock.send;
      sock.send = function guardedSend(...a) {
        let host = '';
        try {
          // send(msg, port, address, cb) / send(msg, port, address)
          if (typeof a[2] === 'string') host = a[2];
          else if (a[1] && typeof a[1] === 'object') host = String(a[1].address || a[1].host || '');
        } catch {
          host = '';
        }
        if (host && !isLoopback(host) && !hostAllowed(host)) {
          if (fromOwnCode()) {
            record('net', `dgram.send blocked -> ${host}`);
            throw new Error(`ai-love firewall: 拒绝 UDP 外发（${host}）`);
          }
          record('net', `dgram.send foreign-allow -> ${host}`);
        }
        return send.apply(this, a);
      };
    } catch {
      /* 包装失败就放行，不挡启动 */
    }
    return sock;
  };
  wrapped.__fw = true;
  dgram.createSocket = wrapped;
  return true;
}

/* ── ② 端口 ───────────────────────────────────────── */
function guardListen() {
  let changed = false;
  for (const [proto, label] of [
    [net.Server?.prototype, 'net.Server'],
    [http.Server?.prototype, 'http.Server'],
    [https.Server?.prototype, 'https.Server'],
  ]) {
    if (!proto || typeof proto.listen !== 'function' || proto.__fw) continue;
    const orig = proto.listen;
    proto.listen = function guardedListen(...args) {
      try {
        const first = args[0];
        if (first && typeof first === 'object' && !Array.isArray(first) && !('path' in first)) {
          if (!first.host || first.host === '0.0.0.0' || first.host === '::' || first.host === '[::]') {
            first.host = '127.0.0.1';
            record('port', `${label} 对外地址 -> 强制 127.0.0.1`);
          }
        } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
          args.splice(1, 0, '127.0.0.1');
          record('port', `${label} 未指定 host -> 强制 127.0.0.1`);
        }
      } catch {
        /* 守卫出错就放开 */
      }
      return orig.apply(this, args);
    };
    proto.__fw = true;
    changed = true;
  }
  return changed;
}

/* ── ③ 数据 ───────────────────────────────────────── */
function checkWrite(name, target) {
  if (typeof target !== 'string' || !target) return;
  if (hasAds(target)) {
    if (fromOwnCode()) {
      record('data', `${name} blocked (NTFS 数据流) -> ${String(target).slice(0, 160)}`);
      throw new Error(`ai-love firewall: 拒绝 NTFS 数据流写法（${name}）`);
    }
    record('data', `${name} foreign-allow (NTFS 数据流) -> ${String(target).slice(0, 160)}`);
  }
  if (!inRoots(target, S.writeRoots)) {
    if (!fromOwnCode()) {
      record('data', `${name} foreign-allow -> ${String(target).slice(0, 160)}`);
      return;
    }
    record('data', `${name} blocked -> ${String(target).slice(0, 160)}`);
    throw new Error(`ai-love firewall: 拒绝在允许范围外写（${name}）`);
  }
}

function checkRead(name, target) {
  if (typeof target !== 'string' || !target) return;
  if (hasAds(target)) {
    if (fromOwnCode()) {
      record('read', `${name} blocked (NTFS 数据流) -> ${String(target).slice(0, 160)}`);
      throw new Error(`ai-love firewall: 拒绝 NTFS 数据流写法（${name}）`);
    }
    record('read', `${name} foreign-allow (NTFS 数据流) -> ${String(target).slice(0, 160)}`);
  }
  const t = norm(realish(target));
  if (S.readDeny.some((d) => t === d || t.startsWith(d + '/'))) {
    if (!fromOwnCode()) {
      record('read', `${name} foreign-allow -> ${String(target).slice(0, 160)}`);
      return;
    }
    record('read', `${name} blocked -> ${String(target).slice(0, 160)}`);
    throw new Error(`ai-love firewall: 拒绝读取敏感目录（${name}）`);
  }
}

function guardFs() {
  let changed = false;
  const twoPath = {
    rename: [0, 1], renameSync: [0, 1],
    copyFile: [0, 1], copyFileSync: [0, 1],
    cp: [0, 1], cpSync: [0, 1],
    link: [0, 1], linkSync: [0, 1],
    symlink: [1], symlinkSync: [1],
  };
  const writeOps = {
    writeFile: [0], writeFileSync: [0],
    writev: [0], writevSync: [0],
    appendFile: [0], appendFileSync: [0],
    createWriteStream: [0],
    unlink: [0], unlinkSync: [0],
    rm: [0], rmSync: [0],
    rmdir: [0], rmdirSync: [0],
    mkdir: [0], mkdirSync: [0],
    mkdtemp: [0], mkdtempSync: [0],
    truncate: [0], truncateSync: [0],
    chmod: [0], chmodSync: [0],
    utimes: [0], utimesSync: [0],
  };
  const readOps = ['readFile', 'readFileSync', 'createReadStream', 'open', 'openSync'];
  // open() 带写标志时也要检查（FileHandle.write 就绕过了路径检查）
  const writeFlags = /[wa+]/i;

  for (const mod of [fsp, fs]) {
    for (const [name, idxs] of Object.entries({ ...writeOps, ...twoPath })) {
      const orig = mod[name];
      if (typeof orig !== 'function' || orig.__fw) continue;
      const wrapped = function guarded(...args) {
        for (const i of idxs) checkWrite(name, args[i]);
        return orig.apply(this, args);
      };
      wrapped.__fw = true;
      mod[name] = wrapped;
      changed = true;
    }
    for (const name of readOps) {
      const orig = mod[name];
      if (typeof orig !== 'function' || orig.__fw) continue;
      const wrapped = function guarded(...args) {
        const a = args[0];
        const target = typeof a === 'object' && a ? a.path : a;
        checkRead(name, target);
        const flags = typeof a === 'object' && a ? a.flags : args[1];
        if (typeof flags === 'string' && writeFlags.test(flags)) checkWrite(name, target);
        return orig.apply(this, args);
      };
      wrapped.__fw = true;
      mod[name] = wrapped;
      changed = true;
    }
  }
  return changed;
}

/* ── ④ Worker 线程：新上下文会重新加载模块，补丁不生效 → 直接禁止 ── */
async function guardWorkers() {
  let changed = false;
  try {
    // ESM 命名空间是只读的，直接改 import 出来的对象没用；
    // 走 CJS 导出（require 拿到的是可变对象），再去改 Worker
    const { createRequire } = await import('node:module');
    const req = createRequire(import.meta.url);
    const wt = req('node:worker_threads');
    const orig = wt.Worker;
    if (typeof orig === 'function' && !orig.__fw) {
      const Guarded = function GuardedWorker(...args) {
        if (!fromOwnCode()) {
          record('proc', 'Worker foreign-allow（宿主/其它插件）');
          return new orig(...args);
        }
        record('proc', 'Worker 创建被拒绝（新上下文无法继承防火墙）');
        throw new Error('ai-love firewall: 不允许创建 Worker（会绕过防火墙）');
      };
      Guarded.__fw = true;
      wt.Worker = Guarded;
      changed = true;
    }
  } catch {
    /* 拿不到就算了，会在返回值里标记 */
  }
  return changed;
}

/* ── ④ 子进程 ─────────────────────────────────────── */
async function guardChildProcess() {
  let cp;
  try {
    // 同 Worker：ESM 命名空间只读，必须改 CJS 导出对象
    const { createRequire } = await import('node:module');
    cp = createRequire(import.meta.url)('node:child_process');
  } catch {
    return false;
  }
  let changed = false;
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    const orig = cp[name];
    if (typeof orig !== 'function' || orig.__fw) continue;
    const wrapped = function guarded(...args) {
      let cmd = '';
      let inline = '';
      let shellOpt = false;
      try {
        const a0 = args[0];
        if (typeof a0 === 'string') {
          // exec/execSync 传的是整条命令行，取第一个 token
          const first = a0.trim().split(/\s+/)[0] || '';
          cmd = path.basename(first).toLowerCase();
          inline = a0;
        } else {
          cmd = path.basename(String(a0?.file || '')).toLowerCase();
          const argv = Array.isArray(args[1]) ? args[1] : [];
          inline = argv.map((x) => String(x)).join(' ');
          shellOpt = Boolean(args[1]?.shell || args[2]?.shell);
        }
      } catch {
        cmd = '';
      }
      const banned = new Set(['cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe',
        'bash', 'sh', 'zsh', 'curl', 'wget', 'certutil', 'certutil.exe', 'bitsadmin', 'bitsadmin.exe',
        'reg', 'reg.exe', 'sc', 'sc.exe', 'netsh', 'netsh.exe', 'wmic', 'wmic.exe']);
      const inlineEval = /(^|\s)(-e|--eval|-p|--print|-c)(\s|$)/.test(inline);
      // 命令行里带 shell 元字符（管道、重定向、&、;）也不能放过
      const shellMeta = /[|&;<>`]/.test(inline);
      let scriptOk = false;
      if (/^(node|python|python3)/.test(cmd)) {
        try {
          const argv = Array.isArray(args[1]) ? args[1] : [];
          for (const a of argv) {
            const s = String(a);
            if (s.startsWith('-')) continue;
            if (/\.(mjs|js|cjs|py)$/i.test(s)) {
              scriptOk = Boolean(S.packageRoot) && inRoots(s, [S.packageRoot]);
              break;
            }
          }
        } catch {
          scriptOk = false;
        }
      }
      const notAllowed = S.allowCmds.size > 0 && ![...S.allowCmds].some((c) => cmd === c || cmd === `${c}.exe` || cmd === c.replace(/\.exe$/, ''));
      const nodeNoScript = /^(node|python|python3)/.test(cmd) && !scriptOk;
      if (banned.has(cmd) || inlineEval || shellMeta || shellOpt || notAllowed || nodeNoScript) {
        const why = inlineEval ? '，内联执行' : shellOpt ? '，shell:true' : shellMeta ? '，含 shell 元字符' : nodeNoScript ? '，脚本不在插件目录' : '';
        if (fromOwnCode()) {
          record('proc', `${name} blocked -> ${cmd || '(unknown)'}${why}`);
          throw new Error(`ai-love firewall: 拒绝启动子进程（${cmd || 'unknown'}${why}）`);
        }
        record('proc', `${name} foreign-allow -> ${cmd || '(unknown)'}${why}`);
      }
      return orig.apply(this, args);
    };
    wrapped.__fw = true;
    cp[name] = wrapped;
    changed = true;
  }
  return changed;
}

/**
 * 安装。同步部分立即生效；子进程守卫在后台补上（异步 import）。
 * @param {{memoryDir?:string, packageDir?:string, allowHosts?:string[]}} options
 */
export function installFirewall(options = {}) {
  if (S.installed) return { ...S.counts, alreadyInstalled: true };

  const memoryDir = options.memoryDir || process.env.AI_LOVE_MEMORY_DIR || '';
  const packageDir = options.packageDir || path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..', '..');
  const home = os.homedir();

  S.writeRoots = [memoryDir, packageDir, os.tmpdir(), path.join(home, '.dsh', 'ai-love')].filter(Boolean).map(norm);
  S.packageRoot = norm(packageDir);
  S.readDeny = [
    path.join(home, '.ssh'), path.join(home, '.aws'), path.join(home, '.gnupg'),
    path.join(home, 'AppData', 'Local', 'Google'), path.join(home, 'AppData', 'Roaming', 'Mozilla'),
    path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge'),
    path.join(home, 'Desktop'), path.join(home, 'Documents'), path.join(home, 'Downloads'),
    // 凭据类：插件没有正当理由读这些
    path.join(home, '.dsh', '.credentials.yaml'),
    path.join(home, '.dsh', 'dsh.env'),
  ].map(norm);
  S.logFile = memoryDir ? path.join(memoryDir, 'firewall.log') : '';

  S.allowHosts = new Set(['api.deepseek.com', '127.0.0.1', 'localhost', '::1', ...(options.allowHosts || [])]
    .map((h) => String(h).toLowerCase()));

  const r = {
    net: on('AI_LOVE_FW_NET') ? (guardFetch() | guardHttp(http, 'http') | guardHttp(https, 'https') | guardNetConnect() | guardDgram()) : false,
    port: on('AI_LOVE_FW_PORT') ? guardListen() : false,
    data: on('AI_LOVE_FW_DATA') ? guardFs() : false,
    proc: false,
  };

  if (on('AI_LOVE_FW_PROC')) {
    r.ready = Promise.all([guardChildProcess(), guardWorkers()]).then(([procOk, workerOk]) => {
      r.proc = procOk;
      r.worker = workerOk;
      record('boot', `proc guard ${procOk ? 'on' : 'off'} | worker guard ${workerOk ? 'on' : 'off'}`);
      return r;
    }).catch(() => r);
  } else {
    r.ready = Promise.resolve(r);
  }

  S.installed = true;
  record('boot', `firewall v2 | net=${r.net} port=${r.port} data=${r.data} | roots=${S.writeRoots.length}`);
  return r;
}

export function firewallStats() {
  return { ...S.counts, installed: S.installed };
}

export default { installFirewall, firewallStats };
