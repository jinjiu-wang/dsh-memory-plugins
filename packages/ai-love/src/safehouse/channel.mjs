/**
 * 安全屋 · 独立通道（管理员 ↔ 隐私区里的 AI）
 *
 * 不是 QQ 消息，也不是普通面板输入：只有两半密钥合一、拿到通道准入票据的人
 * 才能往这里写。每条消息都带上写入瞬间的压力快照 —— 「对话时压力值实时检测」。
 *
 * 落盘：<sharedDir>/channel.jsonl（一行一条，append-only，超长时裁剪重写）。
 * id 在文件锁里递增，避免两个写者拿到同一个号、增量读漏消息。
 */

import path from 'node:path';
import {
  DEFAULTS,
} from './constants.mjs';
import {
  appendLine,
  cleanText,
  ensureDir,
  fileMtime,
  fileSize,
  nowIso,
  readTextSafe,
  withFileLock,
  writeTextAtomic,
} from './util.mjs';

export class Channel {
  constructor(sharedDir, { maxItems = DEFAULTS.channelMaxItems } = {}) {
    this.dir = path.resolve(sharedDir);
    this.file = path.join(this.dir, 'channel.jsonl');
    this.lockFile = path.join(this.dir, 'channel.lock');
    this.maxItems = maxItems;
    this._cache = { key: '', rows: [] };
    ensureDir(this.dir);
  }

  _rows() {
    const key = `${fileMtime(this.file)}:${fileSize(this.file)}`;
    if (key === this._cache.key) return this._cache.rows;
    const text = readTextSafe(this.file, '');
    const rows = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object') rows.push(row);
      } catch {
        /* 半截行忽略 */
      }
    }
    this._cache = { key, rows };
    return rows;
  }

  list({ after = 0, limit = 50 } = {}) {
    const rows = this._rows();
    const start = Number(after) || 0;
    return rows.filter((row) => Number(row.id) > start).slice(0, Math.max(1, Math.min(200, limit)));
  }

  latestId() {
    const rows = this._rows();
    return rows.length === 0 ? 0 : Number(rows[rows.length - 1].id) || 0;
  }

  append({ from, text, pressure = null, deltaPct = null, band = '' } = {}) {
    const body = cleanText(text, DEFAULTS.channelTextMax);
    if (body === '') throw new Error('通道消息不能为空');
    const role = from === 'ai' ? 'ai' : 'admin';
    return withFileLock(this.lockFile, () => {
      const rows = this._rows();
      const row = {
        id: (rows.length === 0 ? 0 : Number(rows[rows.length - 1].id) || 0) + 1,
        at: Date.now(),
        time: nowIso(),
        from: role,
        text: body,
        pressure: pressure === null ? null : Number(pressure),
        deltaPct: deltaPct === null ? null : Number(deltaPct),
        band: cleanText(band, 20),
      };
      appendLine(this.file, JSON.stringify(row));
      this._cache = { key: '', rows: [] };
      this._trim();
      return row;
    });
  }

  _trim() {
    const rows = this._rows();
    if (rows.length <= this.maxItems) return;
    const kept = rows.slice(-this.maxItems);
    writeTextAtomic(this.file, `${kept.map((row) => JSON.stringify(row)).join('\n')}\n`);
    this._cache = { key: '', rows: [] };
  }
}
