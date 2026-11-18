/**
 * 爱ai · 防火墙（插件层纵深防御）
 *
 * L1 写入口：各 store 的路径在 memoryDir 下；面板写路由只做白名单内的动作。
 * L2 完整性：对核心档案做 SHA-256 基线，定时/手动扫描，发现 changed/missing/added。
 * L3 出站：面板与日志只放状态，不放档案正文（调用方保证）。
 *
 * 三重加固（锁非系统盘备份目录）：
 *   1. ACL：icacls 去掉继承，只给当前用户控制；
 *   2. 完整性清单：备份目录文件哈希写入 guard/integrity.json；
 *   3. 恢复演练：把 _raw 快照复制到临时目录并校验可读，失败则禁止「一键找回」。
 *
 * 边界：只保护爱ai 自己的档案，不接管系统防火墙，不扫描其他进程。
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const GUARD_DIR = 'guard';
export const BASELINE_FILE = 'baseline.json';
export const GUARD_LOG = 'guard.jsonl';
export const INTEGRITY_FILE = 'integrity.json';

const CORE_FILES = ['uncertain.jsonl', 'facts.jsonl', 'activity.jsonl', 'compact-consent.json'];

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function hashFile(file) {
  try {
    return sha256(await readFile(file));
  } catch {
    return '';
  }
}

async function listTree(root, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      // 自进化板块只写 .evolve/，不进保护基线，也不走扫描
      if (entry.name === '.evolve') continue;
      if (entry.name === '_restore-0' || entry.name.startsWith('_restore-')) continue;
      out.push(...(await listTree(root, rel)));
    } else {
      out.push(rel);
    }
  }
  return out;
}

export class GuardCenter {
  constructor({ memoryDir, backupDir }) {
    this.memoryDir = memoryDir;
    this.backupDir = backupDir;
    this.dir = path.join(memoryDir, GUARD_DIR);
    this.baseline = null;
    this.lastScan = null;
    this.alerts = [];
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.baseline = JSON.parse(await readFile(path.join(this.dir, BASELINE_FILE), 'utf8'));
    } catch {
      this.baseline = null;
    }
    try {
      const text = await readFile(path.join(this.dir, GUARD_LOG), 'utf8');
      this.alerts = text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .slice(-30);
    } catch {
      this.alerts = [];
    }
  }

  async audit(record) {
    this.alerts.push(record);
    this.alerts = this.alerts.slice(-30);
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(path.join(this.dir, GUARD_LOG), '', { flag: 'a' });
      const { appendFile } = await import('node:fs/promises');
      await appendFile(path.join(this.dir, GUARD_LOG), `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // 留痕失败不影响保护逻辑
    }
  }

  /** 重新建立基线（首次或手动）。 */
  async seal() {
    await this.load();
    const files = {};
    for (const rel of CORE_FILES) {
      const hash = await hashFile(path.join(this.memoryDir, rel));
      if (hash !== '') files[rel] = hash;
    }
    for (const sub of ['summaries']) {
      try {
        for (const name of await readdir(path.join(this.memoryDir, sub))) {
          const rel = `${sub}/${name}`;
          const hash = await hashFile(path.join(this.memoryDir, rel));
          if (hash !== '') files[rel] = hash;
        }
      } catch {
        // 目录还不存在
      }
    }
    this.baseline = { createdAt: Date.now(), memoryDir: this.memoryDir, files };
    await mkdir(this.dir, { recursive: true });
    await writeFile(path.join(this.dir, BASELINE_FILE), `${JSON.stringify(this.baseline, null, 2)}\n`, 'utf8');
    await this.audit({ ts: Date.now(), type: 'seal', count: Object.keys(files).length });
    return { ok: true, createdAt: this.baseline.createdAt, count: Object.keys(files).length };
  }

  /** 扫描：与基线比对，列出 changed / missing / added。 */
  async scan() {
    await this.load();
    if (this.baseline === null) {
      return { ok: false, error: '还没有基线；先点「重新基线」' };
    }
    const expected = this.baseline.files ?? {};
    const findings = { changed: [], missing: [], added: [] };
    for (const [rel, hash] of Object.entries(expected)) {
      const actual = await hashFile(path.join(this.memoryDir, rel));
      if (actual === '') findings.missing.push(rel);
      else if (actual !== hash) findings.changed.push(rel);
    }
    const current = await listTree(this.memoryDir, '');
    // 只看受保护的核心档案与记忆卡；互通文件、留痕、陪伴备注不算核心档案。
    const tracked = (rel) => CORE_FILES.includes(rel) || rel.startsWith('summaries/');
    for (const rel of current) {
      if (rel.startsWith('.evolve/') || rel.startsWith('guard/') || rel.startsWith('_raw') || rel.startsWith('_restore-')) continue;
      if (tracked(rel) && !(rel in expected)) findings.added.push(rel);
    }
    this.lastScan = { at: Date.now(), findings };
    const total = findings.changed.length + findings.missing.length + findings.added.length;
    if (total > 0) {
      await this.audit({ ts: Date.now(), type: 'scan-alert', findings });
    }
    return { ok: true, at: this.lastScan.at, findings, total, baselineCount: Object.keys(expected).length };
  }

  /** 三重加固：ACL / 完整性清单 / 恢复演练。 */
  async harden() {
    const result = { acl: false, integrity: false, drill: false, errors: [] };
    // 1. ACL：只给当前用户，去掉继承。
    if (process.platform === 'win32' && existsSync(this.backupDir)) {
      try {
        const user = process.env.USERNAME ?? '';
        await execFileAsync('icacls', [this.backupDir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`]);
        result.acl = true;
      } catch (error) {
        result.errors.push(`ACL: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // 2. 完整性清单：备份目录 + _raw。
    try {
      const files = {};
      for (const rel of await listTree(this.backupDir, '')) {
        if (rel.startsWith('_restore-')) continue;
        files[rel] = await hashFile(path.join(this.backupDir, rel));
      }
      await mkdir(this.dir, { recursive: true });
      await writeFile(
        path.join(this.dir, INTEGRITY_FILE),
        `${JSON.stringify({ ts: Date.now(), backupDir: this.backupDir, files }, null, 2)}\n`,
        'utf8',
      );
      result.integrity = Object.keys(files).length > 0;
    } catch (error) {
      result.errors.push(`完整性: ${error instanceof Error ? error.message : String(error)}`);
    }
    // 3. 恢复演练：复制 _raw 到临时目录，确认可读。
    try {
      const raw = path.join(this.backupDir, '_raw');
      if (!existsSync(raw)) throw new Error('还没有 _raw 快照，先同步一次备份');
      const drillDir = path.join(this.dir, `_drill-${Date.now()}`);
      await cp(raw, drillDir, { recursive: true, force: true });
      const files = await listTree(drillDir, '');
      result.drill = files.length > 0;
      await rm(drillDir, { recursive: true, force: true });
    } catch (error) {
      result.errors.push(`演练: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.audit({ ts: Date.now(), type: 'harden', result });
    return result;
  }

  /**
   * 恢复前完整性硬校验：只校验清单里记录过的 _raw 文件。
   * 清单里没有的新文件放行（sync 新增）；清单里有的缺失/被改 → 拒绝恢复。
   */
  async verifyBackupIntegrity() {
    await this.load();
    let integrity;
    try {
      integrity = JSON.parse(await readFile(path.join(this.dir, INTEGRITY_FILE), 'utf8'));
    } catch {
      return { ok: false, error: '还没有完整性清单，先执行加固' };
    }
    const files = integrity?.files ?? {};
    const mismatches = [];
    let checked = 0;
    for (const [rel, expected] of Object.entries(files)) {
      if (!rel.startsWith('_raw/')) continue;
      checked += 1;
      const actual = await hashFile(path.join(this.backupDir, rel));
      if (actual === '') mismatches.push({ rel, reason: 'missing' });
      else if (actual !== expected) mismatches.push({ rel, reason: 'changed' });
    }
    if (checked === 0) {
      return { ok: false, error: '完整性清单里没有 _raw 条目，先执行加固' };
    }
    return { ok: mismatches.length === 0, checked, mismatches: mismatches.slice(0, 10) };
  }

  /** 面板用状态（不含档案正文）。 */
  status() {
    return {
      baselineAt: Number(this.baseline?.createdAt ?? 0),
      baselineCount: Object.keys(this.baseline?.files ?? {}).length,
      lastScanAt: Number(this.lastScan?.at ?? 0),
      findings: this.lastScan?.findings ?? null,
      alerts: this.alerts.slice(-10),
    };
  }
}
