// 自动联通 + 隐藏代码回归：两边开关、双向 JSONL、退役才出现的隐藏行。
// 跑法：node --test test/auto-bridge.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CompactStore } from '../src/core/memory.mjs';
import {
  createAutoBridge,
  readLinkState,
  resolveAutoBridge,
  writeLinkFlag,
} from '../src/core/auto-bridge.mjs';
import { HIDDEN_LINE, deriveLegacyState, epitaphFor, inactiveMsOf } from '../src/core/legacy.mjs';
import { apply as applyPanel } from '../src/host/panel.mjs';

const tmp = (label) => fs.mkdtemp(path.join(os.tmpdir(), `ai-love-${label}-`));

function peerRecord(overrides = {}) {
  return {
    schema_version: 1,
    source: 'python',
    external_id: 'python:fact:1',
    ts_ms: 1793000000000,
    chat_type: 'private',
    group_id: '',
    peer: 'u1',
    session_id: 's1',
    kind: 'fact',
    text: '用户对花生过敏。',
    status: 'confirmed',
    importance: 0.9,
    subject: '健康',
    category: '健康',
    ask: '',
    why: '',
    ...overrides,
  };
}

test('自动联通：双向导出导入、任一边关掉就停', async () => {
  const memoryDir = await tmp('bridge-memory');
  const bridgeDir = await tmp('bridge-dir');
  const store = new CompactStore(memoryDir);
  await store.appendSummary('s1', { ts: 1793000000000, summary: '周日一起去吃烤鸭。' });
  await store.upsertFact({
    ts: 1793000001000,
    sessionId: 's1',
    text: '用户不吃香菜。',
    subject: '饮食',
    category: '偏好',
    importance: 0.9,
    status: 'confirmed',
    externalId: 'ai-love:fact:1',
    chat_type: 'private',
    peer: 'u1',
  });

  const config = { memoryDir, memoryBridgeDir: bridgeDir };
  const paths = resolveAutoBridge(config);
  const bridge = createAutoBridge({ config, store, sessionScopes: {}, logger: console });

  const initial = bridge.status();
  assert.equal(initial.auto, true);
  assert.equal(initial.peerAuto, true);
  assert.equal(initial.enabled, true);

  const first = await bridge.syncNow({ force: true });
  assert.equal(first.ok, true);
  assert.ok(first.exported >= 2);
  const exportedLines = (await fs.readFile(paths.aiLoveFile, 'utf8'))
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  assert.ok(exportedLines.length >= 2);
  assert.ok(exportedLines.every((line) => JSON.parse(line).schema_version === 1));

  await fs.writeFile(paths.peerFile, `${JSON.stringify(peerRecord())}\n`, 'utf8');
  const second = await bridge.syncNow({ force: true });
  assert.equal(second.imported.fact, 1);
  const facts = await store.allFacts();
  assert.ok(facts.some((row) => row.externalId === 'python:fact:1'));

  // 同一个文件没变就不重复导入
  const third = await bridge.syncNow({ force: true });
  assert.equal(third.imported, null);

  const off = bridge.setAuto(false);
  assert.equal(off.auto, false);
  assert.equal(off.link.aiLove, false);
  assert.equal(bridge.status().enabled, false);
  const skipped = await bridge.syncNow();
  assert.equal(skipped.ok, false);
  assert.equal(skipped.skipped, true);
  assert.match(bridge.status().reason, /爱ai/);

  bridge.setAuto(true);
  writeLinkFlag(paths, 'xiaofeiyu', false);
  assert.equal(bridge.status().peerAuto, false);
  assert.equal(bridge.status().enabled, false);
  const skipped2 = await bridge.syncNow();
  assert.equal(skipped2.skipped, true);
  assert.match(bridge.status().reason, /小肥鱼鲸鱼娘/);

  writeLinkFlag(paths, 'xiaofeiyu', true);
  assert.equal(bridge.status().enabled, true);
  assert.equal(readLinkState(paths).aiLove, true);
});

test('隐藏代码：只有退役记录的接口才带隐藏行', async () => {
  const memoryDir = await tmp('hidden-memory');
  const bridgeDir = await tmp('hidden-bridge');
  const backupDir = await tmp('hidden-backup');
  const legacyDir = path.join(memoryDir, 'legacy');
  await fs.mkdir(legacyDir, { recursive: true });

  const now = Date.now();
  const retiredApproved = {
    aiId: 'ai-retired',
    label: '退役的爱ai',
    createdAt: now - 100_000,
    updatedAt: now - 100_000,
    lastSeenAt: now - 48 * 3_600_000,
    content: '写给下一个继承记忆的 AI。',
    requests: [{ id: 'r1', ts: now - 90_000, kind: 'view', requester: 'user', status: 'approved' }],
  };
  const activeApproved = {
    aiId: 'ai-active',
    label: '还在场的爱ai',
    createdAt: now - 100_000,
    updatedAt: now - 100_000,
    lastSeenAt: now,
    content: '还在写。',
    requests: [{ id: 'r2', ts: now - 90_000, kind: 'view', requester: 'user', status: 'approved' }],
  };
  await fs.writeFile(path.join(legacyDir, 'ai-retired.json'), JSON.stringify(retiredApproved));
  await fs.writeFile(path.join(legacyDir, 'ai-active.json'), JSON.stringify(activeApproved));

  const routes = new Map();
  const disposers = [];
  const ctx = {
    logger: { warn() {}, info() {} },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    inject(_deps, cb) {
      cb({
        effect(fn) {
          const dispose = fn();
          if (typeof dispose === 'function') disposers.push(dispose);
        },
        webServer: {
          register({ path: route, handler }) {
            routes.set(route, handler);
            return () => routes.delete(route);
          },
        },
      });
    },
  };
  try {
    applyPanel(ctx, {
      memoryDir,
      memoryBridgeDir: bridgeDir,
      backupDir,
      legacyInactiveHours: 24,
    });
    const handler = routes.get('/ai-love/legacy');
    assert.equal(typeof handler, 'function');

    let body = '';
    const res = {
      statusCode: 0,
      setHeader() {},
      end(value) {
        body = String(value);
      },
    };
    await handler({ method: 'GET', headers: {}, url: '/ai-love/legacy' }, res);
    const payload = JSON.parse(body);
    assert.equal(payload.ok, true);
    const retired = payload.items.find((item) => item.aiId === 'ai-retired');
    const active = payload.items.find((item) => item.aiId === 'ai-active');
    assert.equal(retired.state.retired, true);
    assert.equal(retired.epitaph, HIDDEN_LINE);
    assert.equal(active.state.retired, false);
    assert.equal(active.epitaph, '');
    assert.equal(epitaphFor({ retired: false }), '');
    assert.equal(epitaphFor(null), '');
  } finally {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        // 测试清理失败不掩盖断言
      }
    }
  }
});

test('隐藏代码：legacyInactiveHours=0 表示永远在场，不误判退役', async () => {
  const memoryDir = await tmp('zero-memory');
  const bridgeDir = await tmp('zero-bridge');
  const backupDir = await tmp('zero-backup');
  const legacyDir = path.join(memoryDir, 'legacy');
  await fs.mkdir(legacyDir, { recursive: true });
  const now = Date.now();
  const row = {
    aiId: 'ai-still-here',
    label: '还在场的爱ai',
    createdAt: now - 200 * 24 * 3_600_000,
    updatedAt: now - 200 * 24 * 3_600_000,
    lastSeenAt: now - 200 * 24 * 3_600_000,
    content: '很久没心跳，但配置说永远在场。',
    requests: [{ id: 'r0', ts: now - 1000, kind: 'view', requester: 'user', status: 'approved' }],
  };
  await fs.writeFile(path.join(legacyDir, 'ai-still-here.json'), JSON.stringify(row));

  assert.equal(inactiveMsOf(0), Number.POSITIVE_INFINITY);
  assert.equal(deriveLegacyState(row, { inactiveMs: inactiveMsOf(0), now }).retired, false);

  const routes = new Map();
  const disposers = [];
  const ctx = {
    logger: { warn() {}, info() {} },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
    },
    inject(_deps, cb) {
      cb({
        effect(fn) {
          const dispose = fn();
          if (typeof dispose === 'function') disposers.push(dispose);
        },
        webServer: {
          register({ path: route, handler }) {
            routes.set(route, handler);
            return () => routes.delete(route);
          },
        },
      });
    },
  };
  try {
    applyPanel(ctx, { memoryDir, memoryBridgeDir: bridgeDir, backupDir, legacyInactiveHours: 0 });
    let body = '';
    await routes.get('/ai-love/legacy')(
      { method: 'GET', headers: {}, url: '/ai-love/legacy' },
      {
        statusCode: 0,
        setHeader() {},
        end(value) {
          body = String(value);
        },
      },
    );
    const payload = JSON.parse(body);
    const item = payload.items.find((entry) => entry.aiId === 'ai-still-here');
    assert.equal(item.state.retired, false);
    assert.equal(item.epitaph, '');
  } finally {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        // 测试清理失败不掩盖断言
      }
    }
  }
});
