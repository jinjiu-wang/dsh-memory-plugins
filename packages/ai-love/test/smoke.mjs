// ai-love 的纯逻辑烟测：记忆读写、互通、协议、配置。不碰 DSH 运行时，也不需要网络。
// 跑法：node --test test/smoke.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveConfig, resolveCompactSpec, resolveTargetPolicy } from '../src/core/config.mjs';
import { splitUncertain, parseUncertainItems } from '../src/core/uncertain.mjs';
import { CompactStore, renderFacts, renderPending, renderSummary } from '../src/core/memory.mjs';
import { ConsentStore } from '../src/core/compact-consent.mjs';
import { GuardCenter } from '../src/core/guard.mjs';
import { dedupeLines, trimTail, estimateTokens, TUNE_FLOOR } from '../src/core/tokenwise.mjs';
import { factualInstruction, verifyProtocolCard } from '../src/core/protocol.mjs';
import {
  exportRecords,
  importRecords,
  makeRecord,
  sanitizeSummaryText,
} from '../src/core/interop.mjs';
import { CharacterStore } from '../src/core/character.mjs';
import { LegacyStore } from '../src/core/legacy.mjs';
import { BackupManager } from '../src/core/backup.mjs';

const tmp = async (label) => fs.mkdtemp(path.join(os.tmpdir(), `ai-love-${label}-`));

test('默认配置：纯记忆、作用域默认为空', () => {
  const config = resolveConfig({});
  assert.equal(config.style, 'qq');
  assert.equal(config.auto, true);
  assert.equal(config.uncertainNotify, true);
  assert.equal(config.thresholdRatio, 0.8);
  assert.equal(config.retainRatio, 0.16);
  assert.deepEqual(config.sessionScopes, {});
  assert.ok(config.maxTokens > 0);
});

test('配置拒绝未知键、非法值和错误作用域', () => {
  assert.throws(() => resolveConfig({ nope: 1 }), /unknown key/);
  assert.throws(() => resolveConfig({ style: 'poetry' }), /style/);
  assert.throws(() => resolveConfig({ retainRatio: 0.9, thresholdRatio: 0.8 }), /must be less/);
  assert.throws(() => resolveConfig({ sessionScopes: { s1: { chat_type: 'room' } } }), /chat_type/);
  const config = resolveConfig({ sessionScopes: { s1: { chat_type: 'group', group_id: 'g1' } } });
  assert.equal(config.sessionScopes.s1.group_id, 'g1');
});

test('modelPolicies 覆盖阈值并计算预算', () => {
  const config = resolveConfig({
    modelPolicies: [{ provider: 'p', model: 'm', thresholdRatio: 0.5, headroomTokens: 1000 }],
  });
  const policy = resolveTargetPolicy(config, { provider: 'p', model: 'm' });
  assert.equal(policy.thresholdRatio, 0.5);
  assert.equal(resolveCompactSpec(policy, 128000, 4096).maxTokens, 1000);
});

test('待确认解析：JSON 行与纯文本都能吃下', () => {
  const { body, items } = splitUncertain(
    '记忆卡正文\n<uncertain>\n{"what":"生日","why":"只说了月份","ask":"哪一天？"}\n</uncertain>',
  );
  assert.equal(body, '记忆卡正文');
  assert.equal(items.length, 1);
  assert.equal(items[0].what, '生日');
  assert.equal(parseUncertainItems('下周三去哪').length, 1);
});

test('记忆卡：读写、幂等、会话隔离', async () => {
  const dir = await tmp('summary');
  const store = new CompactStore(dir);
  const first = await store.appendSummary('session/a', { ts: 1793000000000, summary: '斜杠会话' });
  await store.appendSummary('session_a', { ts: 1793000001000, summary: '下划线会话' });
  assert.equal((await store.recallSummaries('session/a', 5, ''))[0].summary, '斜杠会话');
  assert.equal((await store.recallSummaries('session_a', 5, ''))[0].summary, '下划线会话');

  const again = await store.upsertSummary('session/a', {
    ts: 1793000002000,
    externalId: first.externalId,
    summary: '更新后的正文',
  });
  assert.equal(again.created, false);
  const rows = await store.readSessionSummaries('session/a');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].summary, '更新后的正文');
});

test('记忆卡渲染：秒/毫秒都显示正确年份', async () => {
  const dir = await tmp('render');
  const store = new CompactStore(dir);
  await fs.mkdir(store.summariesDir, { recursive: true });
  await fs.writeFile(
    path.join(store.summariesDir, 's-ts.jsonl'),
    `${JSON.stringify({ ts: 1793000000, sessionId: 's-ts', content: '秒级摘要' })}\n`,
    'utf8',
  );
  const rows = await store.recallSummaries('s-ts', 5, '');
  const text = renderSummary(rows[0], 1);
  assert.match(text, /2026/);
  assert.match(text, /秒级摘要/);
});

test('事实：写入、按会话读取、提示渲染', async () => {
  const dir = await tmp('facts');
  const store = new CompactStore(dir);
  await store.upsertFact({ sessionId: 's1', text: '喜欢烤鸭', subject: '用户', status: 'confirmed' });
  await store.upsertFact({ sessionId: 's2', text: '别人的事', subject: '别人', status: 'confirmed' });
  const rows = await store.factsFor('s1');
  assert.equal(rows.length, 1);
  assert.equal(renderFacts(rows, { limit: 1 }), '【确定事实】\n- 用户：喜欢烤鸭');
});

test('待确认：状态与回复流程', async () => {
  const dir = await tmp('uncertain');
  const store = new CompactStore(dir);
  await store.addUncertain('s1', [{ what: '生日是哪天', why: '只说了月份', ask: '哪一天？' }]);
  const open = store.openItems('s1');
  assert.equal(open.length, 1);
  await store.replyUncertain(open[0].id, '三月八号');
  assert.equal(store.pendingReplies('s1').length, 1);
  await store.ackUncertain(open[0].id, 'accept');
  assert.equal(store.openItems('s1').length, 0);
  assert.equal(store.countOpenAndResolved('s1').resolved, 1);
});

test('协议：只认事实小节，拒绝人设小节与模板复读', () => {
  const instruction = factualInstruction();
  assert.match(instruction, /纯事实记忆卡/);
  const ok = verifyProtocolCard(
    '## 当前话题\n- 在聊周末爬山\n\n## 发生过什么（时间线）\n- 约了周六八点集合\n',
  );
  assert.equal(ok.ok, true);
  const persona = verifyProtocolCard('## 角色设定\n- 她很温柔\n');
  assert.equal(persona.ok, false);
  const empty = verifyProtocolCard('## 当前话题\n- 当前话题/场景一句话\n');
  assert.equal(empty.ok, false);
});

test('互通：导出剔除人设，导入幂等并保留作用域', async () => {
  const dir = await tmp('interop');
  const store = new CompactStore(dir);
  await store.appendSummary('dsh-1', {
    ts: 1793000000000,
    summary: '## 角色设定\n她温柔\n\n## 事实\n用户喜欢烤鸭',
  });
  const scopes = { 'dsh-1': { chat_type: 'group', group_id: 'g1', peer: 'u1' } };
  const outbound = await exportRecords(store, { sessionScopes: scopes });
  assert.equal(outbound.length, 1);
  assert.equal(outbound[0].chat_type, 'group');
  assert.equal(outbound[0].group_id, 'g1');
  assert.doesNotMatch(outbound[0].text, /角色设定|温柔/);
  assert.match(outbound[0].text, /用户喜欢烤鸭/);

  const inbound = [makeRecord({
    source: 'python-memory',
    externalId: 'py:fact:1',
    ts: 1793000001000,
    chatType: 'private',
    peer: 'dsh-1',
    sessionId: 'dsh-1',
    kind: 'fact',
    text: '对花生过敏',
    status: 'confirmed',
    importance: 0.8,
  })];
  const first = await importRecords(store, inbound, { sessionScopes: scopes });
  const second = await importRecords(store, inbound, { sessionScopes: scopes });
  assert.equal(first.fact, 1);
  assert.equal(second.fact_updated, 1);
  const facts = await store.allFacts();
  assert.equal(facts.length, 1);
  assert.equal(facts[0].chat_type, 'group');
  assert.equal(facts[0].group_id, 'g1');
});

test('去人设清洗：只留事实小节', () => {
  const cleaned = sanitizeSummaryText('## 人设\n- 口癖\n\n## 发生过什么\n- 用户买了烤鸭\n');
  assert.doesNotMatch(cleaned, /人设|口癖/);
  assert.match(cleaned, /用户买了烤鸭/);
  assert.equal(sanitizeSummaryText('## 角色设定\n- 只有人设\n'), '');
});

test('压缩同意：写入与读取', async () => {
  const dir = await tmp('consent');
  const consent = new ConsentStore(dir);
  const row = await consent.create({
    sessionId: 's1',
    trigger: 'pressure',
    range: { start: 0, end: 10 },
    deleteInfo: { count: 2, tokens: 100, preview: '旧消息' },
  });
  const rows = await consent.readAll();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, row.id);
  assert.equal(rows[0].status, 'pending-ai');
});

test('防火墙：核心档案只有记忆文件', async () => {
  const dir = await tmp('guard');
  await fs.writeFile(path.join(dir, 'uncertain.jsonl'), '', 'utf8');
  await fs.writeFile(path.join(dir, 'companion-notes.jsonl'), '{"id":"n1"}\n', 'utf8');
  const guard = new GuardCenter({ memoryDir: dir, backupDir: path.join(dir, 'nobackup') });
  await guard.seal();
  const result = await guard.scan();
  assert.ok(Array.isArray(result.findings.added));
  assert.ok(!result.findings.added.some((rel) => rel.includes('companion')));
});

test('tokenwise 基础工具', () => {
  assert.equal(dedupeLines('a\na\nb'), 'a\nb');
  assert.equal(trimTail('abcdef', 3), 'ab…');
  assert.ok(estimateTokens('中文内容') > 0);
  assert.ok(TUNE_FLOOR.pendingWhy > 0);
});

test('角色卡：三级直通、二级等 AI 表态', async () => {
  const dir = await tmp('character');
  const store = new CharacterStore(dir);
  const direct = await store.createProposal({ markdown: '# 角色卡\n- 说话干脆', level: 3 });
  assert.equal(direct.status, 'applied');
  const card = await store.readCard();
  assert.match(card, /说话干脆/);
  const pending = await store.createProposal({ markdown: '# 角色卡\n- 更温和', level: 2 });
  assert.equal(pending.status, 'pending-ai');
  await store.voteProposal(pending.id, 'approve', '可以');
  const after = await store.readCard();
  assert.match(after, /说话干脆/);
});

test('隐私记录：写自己的记录、继承读取受状态限制', async () => {
  const dir = await tmp('legacy');
  const store = new LegacyStore(dir);
  await store.write('ai-1', '这是一条隐私记录');
  const row = await store.read('ai-1');
  assert.equal(row.content, '这是一条隐私记录');
  const list = await store.list();
  assert.ok(list.some((item) => item.aiId === 'ai-1'));
});

test('备份快照：facts.jsonl 进 _raw 并能找回', async () => {
  const dir = await tmp('backup');
  const memoryDir = path.join(dir, 'memory');
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, 'facts.jsonl'), '{"text":"喜欢下雨天"}\n', 'utf8');
  const backup = new BackupManager({ dir: path.join(dir, 'backup'), intervalMs: 0 });
  await backup.snapshotRaw(memoryDir);
  // 第二次快照走「旧 _raw 改名留底」分支，替换成功后才能从新快照找回。
  await fs.writeFile(path.join(memoryDir, 'facts.jsonl'), '{"text":"还喜欢晴天"}\n', 'utf8');
  await backup.snapshotRaw(memoryDir);
  await fs.writeFile(path.join(memoryDir, 'facts.jsonl'), '{"text":"被改坏了"}\n', 'utf8');
  const restored = await backup.restore(memoryDir);
  assert.ok(restored.restored > 0);
  const after = await fs.readFile(path.join(memoryDir, 'facts.jsonl'), 'utf8');
  assert.match(after, /还喜欢晴天/);
});
