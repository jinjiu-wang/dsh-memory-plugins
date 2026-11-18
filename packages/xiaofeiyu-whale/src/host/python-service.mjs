/** 小肥鱼鲸鱼娘 · Python 记忆服务进程（stdio JSON 行协议） */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.resolve(HERE, '..', '..', 'python', 'bridge_server.py');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PythonService {
  constructor({ python, dbPath, bridgeDir, logger }) {
    this.python = python;
    this.dbPath = dbPath;
    this.bridgeDir = bridgeDir;
    this.logger = logger;
    this.child = null;
    this.starting = false;
    this.ready = false;
    this.stopping = false;
    this.fatal = false;
    this.startedAt = 0;
    this.lastError = '';
    this.stderr = [];
    this.pending = new Map();
    this.seq = 0;
    this.readyWaiters = [];
    this.restartTimer = null;
    this.restartDelay = 2000;
  }

  status() {
    return {
      running: this.ready,
      starting: this.starting,
      pid: this.child?.pid ?? 0,
      python: this.python,
      script: SCRIPT,
      dbPath: this.dbPath,
      bridgeDir: this.bridgeDir,
      startedAt: this.startedAt,
      error: this.lastError,
      stderr: this.stderr.slice(-6).join('\n'),
    };
  }

  start() {
    if (this.child !== null || this.starting) return this.status();
    if (this.fatal) return this.status();
    if (!existsSync(SCRIPT)) {
      this.lastError = `找不到 Python 服务脚本：${SCRIPT}`;
      this.fatal = true;
      return this.status();
    }
    this.starting = true;
    this.ready = false;
    this.stopping = false;
    this.lastError = '';
    let child;
    try {
      child = spawn(
        this.python,
        ['-u', SCRIPT, '--db', this.dbPath, '--bridge-dir', this.bridgeDir],
        {
          cwd: path.dirname(SCRIPT),
          env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch (error) {
      this.starting = false;
      this.lastError = `Python 启动失败：${error instanceof Error ? error.message : String(error)}`;
      this.fatal = true;
      return this.status();
    }
    this.child = child;
    this.startedAt = Date.now();

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line !== '') this._handleLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const text = line.trim();
        if (text === '') continue;
        this.stderr.push(text);
        if (this.stderr.length > 30) this.stderr.shift();
      }
    });
    child.on('error', (error) => {
      this.lastError = `Python 启动失败：${error instanceof Error ? error.message : String(error)}`;
      this.fatal = error?.code === 'ENOENT';
      if (this.child === child) this.child = null;
      this.starting = false;
      this.ready = false;
      this._failAll(new Error(this.lastError));
    });
    child.on('exit', (code, signal) => {
      const ranFor = this.startedAt > 0 ? Date.now() - this.startedAt : 0;
      if (this.child === child) this.child = null;
      this.ready = false;
      this.starting = false;
      if (!this.stopping) {
        this.lastError = this.lastError || `Python 记忆服务已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`;
        if (ranFor > 60_000) this.restartDelay = 2000;
        this._scheduleRestart();
      }
      // 进程已经没了，挂着的调用不可能再回来；立刻失败，别让面板干等到超时。
      this._failAll(
        new Error(this.lastError || `Python 记忆服务已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`),
      );
    });
    return this.status();
  }

  _handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message?.id === 'ready') {
      this.ready = true;
      this.starting = false;
      this.lastError = '';
      this.startedAt = Date.now();
      const waiters = this.readyWaiters.splice(0);
      for (const waiter of waiters) waiter();
      return;
    }
    const key = String(message?.id ?? '');
    const pending = this.pending.get(key);
    if (pending === undefined) return;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    if (message.ok === true) pending.resolve(message.result);
    else pending.reject(new Error(String(message.error || 'Python 调用失败')));
  }

  _failAll(error) {
    const waiters = this.readyWaiters.splice(0);
    for (const waiter of waiters) waiter(error);
    for (const [key, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(key);
    }
  }

  _scheduleRestart() {
    if (this.stopping || this.fatal) return;
    if (this.restartTimer !== null) return;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(30_000, Math.round(this.restartDelay * 1.8));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
    this.restartTimer.unref?.();
  }

  waitReady(timeoutMs = 10000) {
    if (this.ready) return Promise.resolve(true);
    if (this.fatal) return Promise.reject(new Error(this.lastError || 'Python 记忆服务不可用'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.readyWaiters.indexOf(waiter);
        if (index >= 0) this.readyWaiters.splice(index, 1);
        reject(new Error(this.lastError || `Python 记忆服务没有在 ${Math.round(timeoutMs / 1000)} 秒内就绪`));
      }, timeoutMs);
      const waiter = (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(true);
      };
      this.readyWaiters.push(waiter);
    });
  }

  async ensureStarted(timeoutMs = 10000) {
    if (this.ready) return true;
    this.start();
    return this.waitReady(timeoutMs);
  }

  async call(method, params = {}, timeoutMs = 15000) {
    await this.ensureStarted(Math.min(timeoutMs, 10000));
    if (this.child === null) throw new Error(this.lastError || 'Python 记忆服务没有运行');
    const id = String(++this.seq);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Python 调用 ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (child === null) return;
    try {
      child.stdin.write(`${JSON.stringify({ id: 'shutdown', method: 'shutdown' })}\n`);
    } catch {
      // 进程已退出
    }
    const exited = new Promise((resolve) => child.once('exit', resolve));
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        // 已经结束
      }
    }, 300).unref?.();
    await Promise.race([exited, sleep(1500)]);
    if (this.child === child) this.child = null;
    this.ready = false;
  }
}
