// 安装器写入 preset/bundle 目录配置的单元测试。跑法：node --test test/install-config.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  addAiLoveConfigKeys,
  addBundleConfigKeys,
  expectedDirConfig,
  presetDirEntries,
  yamlScalar,
} from '../install.mjs';

const ENTRIES = presetDirEntries({
  backupDir: 'D:\\爱ai',
  linkRoot: 'D:\\爱ai\\sessions',
  memoryBackupRoot: 'D:\\爱ai\\qq-ai-memory-backup',
});

function presetText(eol = '\n') {
  return [
    '    - id: ai-love',
    "      name: 'ai-love/backend'",
    '      config:',
    '        ownerQQ: "123"',
    '        bridgeDir: "C:\\\\repo"',
    '        style: qq',
    '',
    '    - id: command-compact',
  ].join(eol);
}

test('preset 目录配置：缺的键补在 config 块末尾', () => {
  const text = presetText();
  const result = addAiLoveConfigKeys(text, ENTRIES);
  assert.deepEqual(result.added, ['backupDir', 'contextLinkDir', 'memoryBackup', 'memoryBackupDir']);
  assert.deepEqual(result.updated, []);
  const lines = result.text.split('\n');
  const last = lines.findIndex((line) => line.startsWith('    - id: command-compact'));
  assert.equal(lines[last - 2], '        memoryBackupDir: "D:\\\\爱ai\\\\qq-ai-memory-backup"');
  assert.ok(result.text.includes('        style: qq'));
  assert.ok(result.text.includes('        bridgeDir: "C:\\\\repo"'));
  assert.ok(result.text.includes('        ownerQQ: "123"'));
});

test('preset 目录配置：已有键的值不对就订正，不重复插入', () => {
  const text = presetText().replace('        style: qq', '        style: qq\n        backupDir: "C:\\\\old"');
  const result = addAiLoveConfigKeys(text, ENTRIES);
  assert.deepEqual(result.updated, ['backupDir']);
  assert.equal(result.text.match(/backupDir:/g).length, 1);
  assert.ok(result.text.includes('backupDir: "D:\\\\爱ai"'));
  assert.equal(result.text.includes('C:\\\\old'), false);
});

test('preset 目录配置：值已经一致时完全幂等', () => {
  const once = addAiLoveConfigKeys(presetText(), ENTRIES);
  const twice = addAiLoveConfigKeys(once.text, ENTRIES);
  assert.deepEqual(twice.added, []);
  assert.deepEqual(twice.updated, []);
  assert.equal(twice.text, once.text);
});

test('preset 目录配置：CRLF 文件保持 CRLF', () => {
  const result = addAiLoveConfigKeys(presetText('\r\n'), ENTRIES);
  assert.equal(result.text.replace(/\r\n/g, '').includes('\n'), false);
});

test('yamlScalar：带引号与不带引号的路径解析成同一个值', () => {
  const quoted = yamlScalar('  backupDir: "D:\\\\爱ai"\n', 'backupDir');
  const plain = yamlScalar('  backupDir: D:\\爱ai\n', 'backupDir');
  assert.equal(quoted, 'D:\\爱ai');
  assert.equal(plain, 'D:\\爱ai');
  assert.equal(quoted, plain);
  assert.equal(yamlScalar('  memoryBackup: true\n', 'memoryBackup'), 'true');
  assert.equal(yamlScalar('  memoryBackupDir:\n', 'memoryBackupDir'), '');
  assert.equal(yamlScalar('  style: qq\n', 'backupDir'), null);
});

test('expectedDirConfig 与 presetDirEntries 键值一致', () => {
  const paths = {
    backupDir: 'D:\\爱ai',
    linkRoot: 'D:\\爱ai\\sessions',
    memoryBackupRoot: 'D:\\爱ai\\qq-ai-memory-backup',
  };
  assert.deepEqual(expectedDirConfig(paths), [
    ['backupDir', 'D:\\爱ai'],
    ['contextLinkDir', 'D:\\爱ai\\sessions'],
    ['memoryBackup', 'true'],
    ['memoryBackupDir', 'D:\\爱ai\\qq-ai-memory-backup'],
  ]);
  assert.equal(yamlScalar(`  contextLinkDir: D:\\爱ai\\sessions\n`, 'contextLinkDir'), paths.linkRoot);
});

// bundle patch 的真实结构：注释在前，`- insert:` 列表里 `memoryDir: ''` 是锚点。
function bundleText(eol = '\n', tail = ['    - id: ai-love-panel-extra', "      name: 'ai-love/panel'"]) {
  return [
    '# ai-love 的 bundle patch。',
    '- insert:',
    '    - id: ai-love-panel',
    "      name: 'ai-love'",
    '      config:',
    "        memoryDir: ''",
    '',
    ...tail,
  ].join(eol);
}

test('bundle patch：缺的键补在 config 块末尾，不跑到文件开头', () => {
  const result = addBundleConfigKeys(bundleText(), ENTRIES);
  assert.deepEqual(result.added, ['backupDir', 'contextLinkDir', 'memoryBackup', 'memoryBackupDir']);
  assert.deepEqual(result.updated, []);
  const lines = result.text.split('\n');
  assert.equal(lines[0], '# ai-love 的 bundle patch。');
  assert.equal(lines[1], '- insert:');
  const anchor = lines.indexOf("        memoryDir: ''");
  assert.equal(lines[anchor + 1], '        backupDir: "D:\\\\爱ai"');
  assert.equal(lines[anchor + 2], '        contextLinkDir: "D:\\\\爱ai\\\\sessions"');
  assert.equal(lines[anchor + 3], '        memoryBackup: true');
  assert.equal(lines[anchor + 4], '        memoryBackupDir: "D:\\\\爱ai\\\\qq-ai-memory-backup"');
  // 插入点仍在 config 块内，后续列表项没有被顶掉。
  assert.equal(lines[anchor + 5], '');
  assert.equal(lines[anchor + 6], '    - id: ai-love-panel-extra');
});

test('bundle patch：已有键的值不对就订正，不重复插入', () => {
  const text = bundleText().replace("        memoryDir: ''", "        memoryDir: ''\n        backupDir: \"C:\\\\old\"");
  const result = addBundleConfigKeys(text, ENTRIES);
  assert.deepEqual(result.updated, ['backupDir']);
  assert.equal(result.text.match(/backupDir:/g).length, 1);
  assert.equal(result.text.includes('C:\\\\old'), false);
});

test('bundle patch：值已经一致时完全幂等', () => {
  const once = addBundleConfigKeys(bundleText(), ENTRIES);
  const twice = addBundleConfigKeys(once.text, ENTRIES);
  assert.deepEqual(twice.added, []);
  assert.deepEqual(twice.updated, []);
  assert.equal(twice.text, once.text);
});

test('bundle patch：CRLF 文件保持 CRLF', () => {
  const result = addBundleConfigKeys(bundleText('\r\n'), ENTRIES);
  assert.equal(result.text.replace(/\r\n/g, '').includes('\n'), false);
});

test('bundle patch：找不到锚点时返回 null，不误写', () => {
  assert.equal(addBundleConfigKeys('# 空 patch\n- insert: []\n', ENTRIES), null);
});

test('bundle patch：更深的同名嵌套键不被误改', () => {
  const text = bundleText().replace(
    "        memoryDir: ''",
    "        memoryDir: ''\n        extra:\n          backupDir: \"C:\\\\nested\"",
  );
  const result = addBundleConfigKeys(text, ENTRIES);
  assert.deepEqual(result.added, ['backupDir', 'contextLinkDir', 'memoryBackup', 'memoryBackupDir']);
  assert.deepEqual(result.updated, []);
  assert.ok(result.text.includes('          backupDir: "C:\\\\nested"'));
  assert.ok(result.text.includes('        backupDir: "D:\\\\爱ai"'));
  assert.equal(result.text.match(/backupDir:/g).length, 2);
});
