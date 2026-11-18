/**
 * 桥接侧 · 安全屋门闸
 *
 * 只做一件事：读安全屋插件写的 `<DSH_HOME>/safehouse/gate.json`，
 * 告诉桥接「现在要不要把消息投给 AI」。
 *
 * 设计原则（保护 AI，但不拿 AI 的命门开玩笑）：
 *   - fail-open：文件缺失、损坏、超过 45 秒没更新、插件没装/没跑 → 正常投递。
 *     安全屋坏了不应该把 AI 关在门外，也不应该让群友的消息凭空消失。
 *   - 只读文件，不连 HTTP、不读聊天正文；桥接和插件之间没有网络依赖。
 *   - 消息照旧进 social-v2 的 unread/recent，OneBot / DSH 连接都不动 ——
 *     「收不到消息」只是不投递，不是断线。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_STALE_MS = 45_000;

/** 与插件侧同一口径：DSH_HOME 优先，否则 ~/.dsh。 */
function expandHome(value) {
  const text = String(value ?? '').trim();
  if (text === '~') return os.homedir();
  if (text.startsWith('~/') || text.startsWith('~\\')) return path.join(os.homedir(), text.slice(2));
  return text;
}

export function safehouseHome() {
  const env = expandHome(process.env.DSH_HOME);
  if (env !== '') return path.resolve(env);
  return path.join(os.homedir(), '.dsh');
}

/** 插件自定义 sharedDir 时会在 <DSH_HOME>/safehouse-dir.txt 留指针；读不到就按默认。 */
function readDirPointer() {
  try {
    const text = fs.readFileSync(path.join(safehouseHome(), 'safehouse-dir.txt'), 'utf8')
      .replace(/^\uFEFF/, '')
      .trim();
    if (text === '') return '';
    const expanded = expandHome(text);
    return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(safehouseHome(), expanded);
  } catch {
    return '';
  }
}

export function safehouseDir(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return path.resolve(configured.trim());
  // 插件侧支持 DSH_SAFEHOUSE_DIR；桥接读同一个变量，配置改了目录时不会静默失配。
  const env = expandHome(process.env.DSH_SAFEHOUSE_DIR);
  if (env !== '') return path.resolve(env);
  const pointer = readDirPointer();
  if (pointer !== '') return pointer;
  return path.join(safehouseHome(), 'safehouse');
}

/**
 * 同步读 gate。返回对象永远有 hold 字段；任何异常都按「不挡」处理。
 * @returns {{hold:boolean, reason:string, phase?:string, locked?:boolean, pressure?:number|null, deltaPct?:number|null, band?:string, accept?:string, acceptUntil?:number, source:'gate'|'missing'|'stale'|'invalid'}}
 */
export function readSafehouseGate({
  dir,
  staleMs = DEFAULT_STALE_MS,
  now = Date.now(),
} = {}) {
  const file = path.join(safehouseDir(dir), 'gate.json');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { hold: false, reason: 'no-gate', source: 'missing' };
  }
  if (now - stat.mtimeMs > staleMs) {
    return { hold: false, reason: 'gate-stale', source: 'stale' };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return { hold: false, reason: 'gate-invalid', source: 'invalid' };
  }
  if (!raw || typeof raw !== 'object' || raw.v !== 1) {
    return { hold: false, reason: 'gate-invalid', source: 'invalid' };
  }
  const expiresAt = Number(raw.expiresAt) || 0;
  if (expiresAt > 0 && expiresAt <= now) {
    return { hold: false, reason: 'gate-expired', source: 'stale' };
  }
  const hold = raw.hold === true;
  return {
    hold,
    reason: String(raw.reason ?? ''),
    phase: String(raw.phase ?? ''),
    locked: raw.locked === true,
    pressure: raw.pressure === null || raw.pressure === undefined ? null : Number(raw.pressure),
    deltaPct: raw.deltaPct === null || raw.deltaPct === undefined ? null : Number(raw.deltaPct),
    band: String(raw.band ?? ''),
    accept: String(raw.accept ?? ''),
    acceptUntil: Number(raw.acceptUntil) || 0,
    source: 'gate',
  };
}

/** 桥接里用的一行摘要，日志和调试用。 */
export function describeGate(gate) {
  if (!gate || !gate.hold) return '安全屋未拦截';
  return `安全屋拦截（${gate.reason || 'open'}，压力 ${gate.pressure ?? '?'}/100，波动 +${gate.deltaPct ?? '?'}%）；消息照常入库，等 AI 主动放行或退出`;
}
