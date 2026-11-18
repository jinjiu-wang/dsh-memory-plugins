/**
 * 安全屋 · 两级密钥
 *
 * 第一层：自动调节密钥（AI 掌控）
 *   - 一个「授权槽」l1.json：AI 通过自己的工具决定开/关、轮换 nonce。
 *   - 它只能决定「我愿不愿意用这个权限」，不能越过压力档位强开。
 *   - 进入安全屋时用它和 linkKey 合成一次性的 openToken（只做审计与防伪）。
 *
 * 第二层：分半密钥（管理员掌控，A/B 两半）
 *   - A 半私钥只存在 ai-love 的目录里，B 半只存在 ai-companion 的目录里。
 *   - 两半通过共享目录交换**公钥**，用 ECDH 合成 linkKey；私钥从不出门。
 *   - 任一侧插件没装 / 没开 / 心跳过期 → linkKey 算不出来 → 开关打不开，
 *     独立通道也打不开。这就是「两半合一」的真正含义。
 *   - linkKey 只在内存里缓存 30 秒，不落盘。
 */

import { createECDH, createHmac, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { renameSync } from 'node:fs';
import path from 'node:path';
import {
  DEFAULTS,
  PLUGIN,
  ROLE,
  PEER_PLUGIN,
} from './constants.mjs';
import {
  ensureDir,
  fileMtime,
  hardenFile,
  nowIso,
  readJsonSafe,
  readTextResult,
  safeEqualHex,
  sha256,
  writeJsonAtomic,
  writeTextAtomic,
} from './util.mjs';

export const PEER_ROLE = ROLE === 'a' ? 'b' : 'a';
const HALF_LEN = 32;

function roleLabel(role) {
  return role === 'a' ? 'ai-love' : 'ai-companion';
}

/** HKDF-SHA256，长度 32。 */
function deriveKey(secret, salt, info) {
  const out = hkdfSync('sha256', secret, salt, info, 32);
  return Buffer.from(out);
}

/** P-256 私钥必须落在 [1, n-1]；坏文件直接当不存在，避免整个插件起不来。 */
function isUsablePrivateKey(buf) {
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(buf);
    return true;
  } catch {
    return false;
  }
}

export class Keyring {
  constructor({ sharedDir, pluginDir } = {}) {
    this.sharedDir = sharedDir;
    this.pluginDir = pluginDir;
    this.linkDir = path.join(sharedDir, 'link');
    this.l1File = path.join(sharedDir, 'l1.json');
    this.halfFile = path.join(pluginDir, 'keys', `half-${ROLE}.key`);
    // TOFU 固定对端公钥：第一次见到就记住，之后换了公钥一律不认。
    // 共享目录里的 .pub.json 没有签名，只靠它等于「谁写文件谁是另一半」。
    this.pinFile = path.join(pluginDir, 'keys', `peer-${PEER_ROLE}.pin`);
    this._priv = null;
    this._link = null; // { key: Buffer, epoch, at }
    this._peerReason = '';
    // 半私钥「有文件但读不出来」时为 'key-unreadable'：此时绝不重新生成。
    this._keyError = '';
  }

  /* ── 第一层：自动调节密钥 ─────────────────────────────── */

  readL1() {
    const raw = readJsonSafe(this.l1File, null);
    const enabled = raw?.enabled !== false; // 默认给 AI 授权，AI 可以关掉
    const nonce = typeof raw?.nonce === 'string' && /^[0-9a-f]{32,128}$/.test(raw.nonce) ? raw.nonce : '';
    return {
      enabled,
      nonce,
      updatedAt: Number(raw?.updatedAt) || 0,
      by: typeof raw?.by === 'string' ? raw.by : '',
    };
  }

  /** AI 侧操作：开关授权槽；每次打开顺手轮换 nonce。 */
  writeL1({ enabled, rotate = false, by = 'ai' } = {}) {
    const before = this.readL1();
    const next = {
      v: 1,
      enabled: typeof enabled === 'boolean' ? enabled : before.enabled,
      nonce: rotate || before.nonce === '' ? randomBytes(HALF_LEN).toString('hex') : before.nonce,
      updatedAt: Date.now(),
      by,
    };
    ensureDir(this.sharedDir);
    writeJsonAtomic(this.l1File, next);
    return { ...next, updatedAtText: nowIso(next.updatedAt) };
  }

  /* ── 第二层：分半密钥（ECDH） ────────────────────────── */

  /** 半私钥只在本插件目录生成一次，从不写共享目录。 */
  privateKeyBytes() {
    if (this._priv !== null) return this._priv;
    const read = readTextResult(this.halfFile);
    if (read.ok) {
      const text = String(read.text).trim();
      const buf = text === '' ? null : Buffer.from(text, 'base64');
      if (buf !== null && buf.length === HALF_LEN && isUsablePrivateKey(buf)) {
        this._priv = buf;
        this._keyError = '';
        return buf;
      }
      // 内容确实坏了（空文件 / base64 不对 / 不是合法 P-256）：先留证据再重建。
      try {
        renameSync(this.halfFile, `${this.halfFile}.bad-${Date.now()}`);
      } catch {
        /* 备份不了也继续重建，否则安全屋永远起不来 */
      }
    } else if (read.code !== 'ENOENT') {
      // EACCES / EPERM / EBUSY：文件在，只是这一下读不了。绝不能覆盖 ——
      // 覆盖后对端 TOFU 指纹永久对不上，等于把两台机器锁死在 peer-untrusted。
      this._keyError = 'key-unreadable';
      const error = new Error(`半私钥读不出来（${read.code}），不覆盖`);
      error.code = 'EKEYREAD';
      throw error;
    }
    const buf = randomBytes(HALF_LEN);
    ensureDir(path.dirname(this.halfFile));
    writeTextAtomic(this.halfFile, `${buf.toString('base64')}\n`);
    hardenFile(this.halfFile);
    this._priv = buf;
    this._keyError = '';
    return buf;
  }

  /** 每侧公布自己的临时公钥（65 字节未压缩点），公开信息，不敏感。 */
  publishPublic(now = Date.now()) {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(this.privateKeyBytes());
    const pub = ecdh.getPublicKey('base64');
    const entry = {
      v: 1,
      role: ROLE,
      plugin: PLUGIN,
      pub,
      updatedAt: now,
    };
    ensureDir(this.linkDir);
    writeJsonAtomic(path.join(this.linkDir, `${ROLE}.pub.json`), entry);
    writeJsonAtomic(path.join(this.linkDir, `${ROLE}.heartbeat.json`), {
      v: 1,
      role: ROLE,
      plugin: PLUGIN,
      at: now,
      // 心跳绑定公钥指纹：对端换钥后旧心跳不能继续冒充在线。
      pubHash: sha256(pub),
    });
    // 我方公钥变了 → 之前缓存的 linkKey 作废
    this._link = null;
    return entry;
  }

  peerPublic() {
    const file = path.join(this.linkDir, `${PEER_ROLE}.pub.json`);
    const raw = readJsonSafe(file, null);
    if (!raw || typeof raw.pub !== 'string' || raw.role !== PEER_ROLE) return null;
    if (raw.plugin !== PEER_PLUGIN) return null;
    let pubBytes;
    try {
      pubBytes = Buffer.from(raw.pub, 'base64');
    } catch {
      return null;
    }
    if (pubBytes.length !== 65) return null;
    const age = Date.now() - Number(raw.updatedAt || 0);
    if (age > DEFAULTS.linkTtlMs * 2) return null;
    const hash = sha256(raw.pub);
    const pinRead = readTextResult(this.pinFile);
    if (!pinRead.ok && pinRead.code !== 'ENOENT') {
      // pin 存在但读不了：不能当成「第一次见」再写一遍，否则会悄悄重新 TOFU。
      this._peerReason = 'pin-unreadable';
      return null;
    }
    const pin = pinRead.ok ? pinRead.text.trim() : '';
    if (pin === '') {
      // TOFU：第一次见到对端公钥就固定下来。之后对端换钥需要人工清掉 pin 文件。
      try {
        ensureDir(path.dirname(this.pinFile));
        writeTextAtomic(this.pinFile, `${hash}\n`);
        hardenFile(this.pinFile);
      } catch {
        // 固定不下来就不认这个对端：没有 pin 的链路和没锁的门一样。
        this._peerReason = 'pin-unwritable';
        return null;
      }
      this._peerReason = '';
    } else if (pin !== hash) {
      this._peerReason = 'peer-untrusted';
      return null;
    } else {
      this._peerReason = '';
    }
    return { ...raw, hash };
  }

  peerHeartbeatAge() {
    const file = path.join(this.linkDir, `${PEER_ROLE}.heartbeat.json`);
    const at = fileMtime(file);
    if (at === 0) return Infinity;
    return Math.max(0, Date.now() - at);
  }

  peerAlive() {
    if (this.peerHeartbeatAge() > DEFAULTS.linkTtlMs) return false;
    const hb = readJsonSafe(path.join(this.linkDir, `${PEER_ROLE}.heartbeat.json`), null);
    if (!hb || hb.role !== PEER_ROLE || hb.plugin !== PEER_PLUGIN) return false;
    const pub = readJsonSafe(path.join(this.linkDir, `${PEER_ROLE}.pub.json`), null);
    if (!pub || typeof pub.pub !== 'string') return false;
    // 心跳必须和当前公钥对得上，防止拿旧心跳续命。
    return typeof hb.pubHash === 'string' && hb.pubHash === sha256(pub.pub);
  }

  /** 合成 linkKey；任何一半不在场都返回 null。 */
  linkKey() {
    if (this._link !== null && Date.now() - this._link.at < DEFAULTS.linkTtlMs) return this._link;
    if (!this.peerAlive()) {
      this._link = null;
      return null;
    }
    const peer = this.peerPublic();
    if (!peer) {
      this._link = null;
      return null;
    }
    if (!this.peerAlive()) {
      this._link = null;
      return null;
    }
    try {
      const ecdh = createECDH('prime256v1');
      ecdh.setPrivateKey(this.privateKeyBytes());
      const shared = ecdh.computeSecret(Buffer.from(peer.pub, 'base64'));
      const epoch = sha256(
        [ROLE, PEER_ROLE]
          .map((role) => (role === ROLE ? this.minePub() : peer.pub))
          .sort()
          .join('|'),
      ).slice(0, 16);
      const key = deriveKey(shared, Buffer.from(epoch, 'utf8'), 'safehouse-link-v1');
      this._link = { key, epoch, at: Date.now(), peer: PEER_PLUGIN };
      return this._link;
    } catch {
      this._link = null;
      return null;
    }
  }

  minePub() {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(this.privateKeyBytes());
    return ecdh.getPublicKey('base64');
  }

  linkState() {
    const link = this.linkKey();
    return {
      ok: link !== null,
      peer: PEER_PLUGIN,
      epoch: link?.epoch ?? '',
      peerAgeMs: this.peerAlive() ? this.peerHeartbeatAge() : -1,
      reason: link !== null
        ? ''
        : !this.peerAlive()
          ? 'peer-offline'
          : this._keyError !== ''
            ? this._keyError
            : this._peerReason !== ''
              ? this._peerReason
              : 'peer-public-missing',
      l1: this.readL1(),
    };
  }

  /** 进安全屋时合成的一次性令牌（审计用；不用于放行判断）。 */
  openToken(nonce = '') {
    const link = this.linkKey();
    if (!link) return '';
    return createHmac('sha256', link.key)
      .update(`open|${String(nonce)}|${link.epoch}|${ROLE}`)
      .digest('hex');
  }

  /* ── 独立通道的准入票据 ─────────────────────────────── */

  /** 5 分钟一个桶，允许时钟漂移 ±1 桶。 */
  static bucketOf(now = Date.now()) {
    return Math.floor(now / (5 * 60_000));
  }

  channelToken(now = Date.now()) {
    const link = this.linkKey();
    if (!link) return '';
    return createHmac('sha256', link.key)
      .update(`channel|${ROLE}|${link.epoch}|${Keyring.bucketOf(now)}`)
      .digest('hex');
  }

  verifyChannelToken(token, senderRole = PEER_ROLE, now = Date.now()) {
    const link = this.linkKey();
    if (!link) return false;
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return false;
    const want = senderRole === ROLE ? this.channelToken(now) : this.peerChannelToken(link, senderRole, now);
    if (want !== '' && safeEqualHex(want, token)) return true;
    // 允许 ±1 个桶的时钟漂移
    for (const offset of [-1, 1]) {
      const shifted = now + offset * 5 * 60_000;
      const candidate = senderRole === ROLE
        ? this.channelToken(shifted)
        : this.peerChannelToken(link, senderRole, shifted);
      if (candidate !== '' && safeEqualHex(candidate, token)) return true;
    }
    return false;
  }

  peerChannelToken(link, senderRole, now) {
    const role = senderRole || PEER_ROLE;
    return createHmac('sha256', link.key)
      .update(`channel|${role}|${link.epoch}|${Keyring.bucketOf(now)}`)
      .digest('hex');
  }

  /** 链路成立与否 + 一个稳定指纹，供面板显示（不泄密）。 */
  fingerprint() {
    const link = this.linkKey();
    if (!link) return '';
    return createHash('sha256').update(link.key).digest('hex').slice(0, 12);
  }
}

export { roleLabel };
