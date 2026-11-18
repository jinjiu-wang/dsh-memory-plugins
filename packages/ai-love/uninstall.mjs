#!/usr/bin/env node
// ai-love 卸载器
//
// 回滚安装器做过的事：
//   1. 还原 QQ preset 里的 compaction-basic（优先用安装时的 .ai-love.bak）
//   2. 重新生成 qq-agent-presets 的 bundle patch
//   3. 还原 qq-tool-restrict 白名单（优先 .bak-ai-love，没有就逐行摘掉全部历史工具名）
//   4. 从 profile package.json / node_modules 移除依赖，清掉 .ai-love.bak
//   5. 删除 ~/.dsh/plugins/ai-love
//
// 默认**保留**记忆档案（~/.dsh/ai-love）；要一起删加 --purge-memory。
//
// 用法：
//   node uninstall.mjs
//   node uninstall.mjs --repo "D:\qq-bridge" --profile desktop
//   node uninstall.mjs --purge-memory
//   node uninstall.mjs --unlink-context   # 先把 QQ 会话日志回迁到 C:（DSH 必须先退出）
//   node uninstall.mjs --unlink-context --force  # 回迁失败也强删安装副本（数据留在联通目录）
//   node uninstall.mjs --unlink-context --sessions "C:\Users\...\.dsh\sessions"
//   node uninstall.mjs --unlink-context --link-root "D:\爱ai\sessions"
//   --allow-running 只给沙盒用：DSH 运行中回迁可能损坏正在写的日志
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveLinkRoot, scanContextLinks, unlinkContextLinks } from './src/core/context-link.mjs';

const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PKG_NAME = 'ai-love';
const PRESETS = ['qq-chat-v2', 'qq-chat'];

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = args[i + 1];
  // 漏写值时别把下一个开关当成路径，否则会扫错目录、看不到待回迁的数据。
  return typeof value === 'string' && !value.startsWith('--') ? value : undefined;
};
const flag = (name) => args.includes(`--${name}`);
const DRY = flag('dry-run');
const PURGE = flag('purge-memory');
const UNLINK_CONTEXT = flag('unlink-context');
const FORCE = flag('force');
const LINK_SESSIONS = opt('sessions');
const LINK_ROOT_ARG = opt('link-root');
const ALLOW_RUNNING = flag('allow-running');

const log = (s) => console.log(s);

function readText(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return env.trim();
  return path.join(os.homedir(), '.dsh');
}

function findRepo() {
  const given = opt('repo') ?? process.env.QQ_BRIDGE_DIR;
  const probes = given
    ? [path.resolve(given)]
    : [
        process.cwd(),
        path.join(process.cwd(), '..'),
        path.join(process.cwd(), 'qq-bridge-main'),
        path.join(process.cwd(), 'qq-bridge'),
        path.join(os.homedir(), 'qq-bridge'),
        path.join(os.homedir(), 'Documents', 'qq-bridge'),
      ];
  for (const probe of probes) {
    try {
      if (
        fs.existsSync(path.join(probe, 'src', 'bridge.js')) &&
        fs.existsSync(path.join(probe, 'dsh', 'agent-presets'))
      ) {
        return probe;
      }
    } catch {
      // 继续
    }
  }
  return null;
}

function findProfile() {
  const base = path.join(dshHome(), 'profiles');
  const given = opt('profile');
  if (given) {
    const p = path.isAbsolute(given) ? given : path.join(base, given);
    return fs.existsSync(path.join(p, 'package.json')) ? p : null;
  }
  const preferred = path.join(base, 'desktop');
  if (fs.existsSync(path.join(preferred, 'package.json'))) return preferred;
  const web = path.join(base, 'web');
  return fs.existsSync(path.join(web, 'package.json')) ? web : null;
}

function findRuntime() {
  const base = path.join(dshHome(), 'dsh-runtimes');
  try {
    for (const dir of fs.readdirSync(base, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const root = path.join(base, dir.name, 'dependencies');
      const pnpm = path.join(root, 'pnpm', 'bin', 'pnpm.mjs');
      if (!fs.existsSync(pnpm)) continue;
      const node = path.join(root, 'node', 'bin', 'node.exe');
      return { node: fs.existsSync(node) ? node : process.execPath, pnpm };
    }
  } catch {
    // 忽略
  }
  return { node: process.execPath, pnpm: null };
}

/** 还原某个 preset：优先用备份，其次反向替换。 */
function restorePreset(file) {
  if (!fs.existsSync(file)) return { file, restored: false, reason: '文件不存在' };
  const bak = `${file}.ai-love.bak`;
  if (fs.existsSync(bak)) {
    if (!DRY) fs.copyFileSync(bak, file);
    if (!DRY) fs.rmSync(bak, { force: true });
    log(`  ✔ 从备份还原 ${path.basename(path.dirname(file))}/agent.cordis.yml`);
    return { file, restored: true };
  }
  const text = readText(file);
  const hasRow = text.includes(`name: '${PKG_NAME}/backend'`) || text.includes(`name: '${PKG_NAME}'`);
  if (!hasRow) return { file, restored: false, reason: '没有 ai-love 行' };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  let patched = false;
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^([ \t]*)-\s+id:\s+ai-love\s*$/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1];
    const next = lines[i + 1] ?? '';
    if (!/^\s*name:\s*'(ai-love\/backend|ai-love)'/.test(next)) continue;
    // 后面如果有 config: 行，一起吃掉
    let end = i + 2;
    while (end < lines.length && /^\s+/.test(lines[end]) && !/^\s*-\s/.test(lines[end])) end += 1;
    lines.splice(
      i,
      end - i,
      `${indent}- id: compaction-basic`,
      `${indent}  name: '@deepseek-ai/dsh-compaction-basic'`,
    );
    patched = true;
    break;
  }
  if (!patched) return { file, restored: false, reason: '结构不匹配，未改' };
  if (!DRY) fs.writeFileSync(file, lines.join(eol), 'utf8');
  log(`  ✔ 反向替换回 compaction-basic`);
  return { file, restored: true };
}

/** ai-love 注册过给模型的工具名（含旧版名字，卸载时一并摘干净）。 */
const AI_LOVE_TOOLS = [
  'compact_recall',
  'compact_pending',
  'compact_consent',
  'memory_facts',
  'memory_export',
  'memory_import',
  'character_check',
  'character_update',
  'character_summarize',
  'character_export',
  'character_vote',
  'legacy_write',
  'legacy_review',
  'legacy_read',
];

/** 把白名单文本里的 ai-love 工具名逐行摘掉（只删这些名字，别的手工工具名不动）。 */
function stripAiLoveTools(text) {
  let removedNames = 0;
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (
      /^\s*\/\//.test(line) &&
      /ai-love|compact_recall|compact_pending|compact_consent|memory_facts|memory_export|memory_import|角色卡|隐私记录|character_|legacy_/.test(line)
    ) {
      continue;
    }
    let next = line;
    for (const tool of AI_LOVE_TOOLS) {
      next = next.replace(new RegExp(`'${tool}',?`, 'g'), () => {
        removedNames += 1;
        return '';
      });
    }
    if (next !== line && next.replace(/[',\s]/g, '') === '') continue;
    out.push(next);
  }
  return { text: out.join('\n'), removedNames };
}

/** 还原 qq-tool-restrict 白名单：优先 .bak-ai-love；没备份就摘掉工具名。 */
function restoreToolRestrict(repo) {
  const file = path.join(repo, 'plugins', 'qq-agent-presets', 'qq-tool-restrict.mjs');
  if (!fs.existsSync(file)) {
    log('  · 没找到 qq-tool-restrict.mjs，跳过');
    return;
  }
  const bak = `${file}.bak-ai-love`;
  if (fs.existsSync(bak)) {
    if (!DRY) fs.copyFileSync(bak, file);
    if (!DRY) fs.rmSync(bak, { force: true });
    log('  ✔ 白名单已从 .bak-ai-love 还原');
    return;
  }
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes("'compact_consent'")) {
    log('  · 白名单里没有 ai-love 工具名');
    return;
  }
  const stripped = stripAiLoveTools(text);
  if (stripped.removedNames === 0) {
    log('  ⚠️  认不出 ai-love 工具行，白名单未改（请手动摘除历史工具名）');
    return;
  }
  if (DRY) {
    log(`  (dry) 会从白名单摘掉 ${stripped.removedNames} 个 ai-love 工具名`);
    return;
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  fs.writeFileSync(file, stripped.text.split(/\r?\n/).join(eol), 'utf8');
  log(`  ✔ 白名单已摘掉 ${stripped.removedNames} 个 ai-love 工具名`);
}

function rebuild(repo, runtime) {
  const script = path.join(repo, 'scripts', 'build-agent-preset-patches.mjs');
  if (!fs.existsSync(script)) {
    log('  ⚠️  找不到 build-agent-preset-patches.mjs，跳过');
    return;
  }
  if (DRY) {
    log('  (dry) 重新生成 bundle patch');
    return;
  }
  const result = spawnSync(runtime.node, [script], { cwd: repo, encoding: 'utf8', timeout: 60000 });
  if (result.status !== 0) {
    log('  ❌ 生成失败：');
    if (result.stdout) log(result.stdout.trim());
    if (result.stderr) log(result.stderr.trim());
    return;
  }
  log('  ✔ bundle patch 已重新生成');
}

function removeFromProfile(profile, runtime) {
  const pkgFile = path.join(profile, 'package.json');
  if (!fs.existsSync(pkgFile)) return;
  const pkg = JSON.parse(readText(pkgFile));
  let dirty = false;
  if (pkg.dependencies && typeof pkg.dependencies[PKG_NAME] === 'string') {
    delete pkg.dependencies[PKG_NAME];
    dirty = true;
    log(`  ✔ 从 profile package.json 移除依赖`);
  }
  if (Array.isArray(pkg.dsh?.profile?.bundles)) {
    const next = pkg.dsh.profile.bundles.filter((name) => name !== PKG_NAME);
    if (next.length !== pkg.dsh.profile.bundles.length) {
      pkg.dsh.profile.bundles = next;
      dirty = true;
      log(`  ✔ 从 dsh.profile.bundles 移除 ${PKG_NAME}（左侧栏入口不再加载）`);
    }
  }
  if (dirty && !DRY) fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  // 依赖与 bundle 已从当前清单摘掉，安装时的 .ai-love.bak 不再需要。
  const bak = `${pkgFile}.ai-love.bak`;
  if (fs.existsSync(bak)) {
    if (!DRY) fs.rmSync(bak, { force: true });
    log('  ✔ 清理 profile package.json 的 .ai-love.bak');
  }
  const target = path.join(profile, 'node_modules', PKG_NAME);
  if (fs.existsSync(target)) {
    if (DRY) {
      log(`  (dry) 会删除 ${target}`);
    } else {
      fs.rmSync(target, { recursive: true, force: true });
      log(`  ✔ 删除 ${target}`);
    }
  }
  // 不自动跑 pnpm install：它会按 lock 重装整棵依赖树，风险大于收益。
  // 清单和 node_modules 已经一致；用户下次自己跑 pnpm install 也是干净状态。
  log('  · 未执行 pnpm install（清单已同步，下次手动安装即可）');
}

function readInstallState() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dshHome(), 'plugins', PKG_NAME, '.install-state.json'), 'utf8'));
  } catch {
    return {};
  }
  // 安装状态只对同一个 DSH 主目录有效；换过 home 的旧状态不能拿来定位。
  const recorded = typeof raw?.dshHome === 'string' ? raw.dshHome.trim() : '';
  if (recorded !== '' && path.resolve(recorded).toLowerCase() !== path.resolve(dshHome()).toLowerCase()) {
    return {};
  }
  return raw;
}

log(`ai-love 卸载器`);
log('='.repeat(60));

const REPO = findRepo();
const PROFILE = findProfile();
const RUNTIME = findRuntime();
const installDir = path.join(dshHome(), 'plugins', PKG_NAME);

log(`qq-bridge: ${REPO ?? '(未找到)'}`);
log(`profile  : ${PROFILE ?? '(未找到)'}`);
log(`模式     : ${DRY ? 'dry-run（不写盘）' : '正式卸载'}`);

// Windows 下删不掉“正在使用”的目录：从安装副本里面跑会删到一半失败。
if (!DRY) {
  const rel = path.relative(path.resolve(installDir), path.resolve(process.cwd()));
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    log(`\n⚠️  当前目录在安装副本里（${installDir}），Windows 删不掉自己，先停在这里。`);
    log('    请换到源码目录或任意其它目录，用完整路径重跑本脚本。');
    process.exit(1);
  }
}

// 安装副本马上要删，先把联通状态读出来。
const installState = readInstallState();
const linkRoot =
  typeof LINK_ROOT_ARG === 'string' && LINK_ROOT_ARG.trim() !== ''
    ? path.resolve(LINK_ROOT_ARG)
    : typeof installState.contextLinkRoot === 'string' && installState.contextLinkRoot.trim() !== ''
      ? installState.contextLinkRoot
      : resolveLinkRoot({ backupDir: installState.backupDir ?? '' });
// 用安装时记录的 sessions 根，避免 DSH_HOME 变动后扫错地方；命令行可覆盖。
const linkSessions =
  typeof LINK_SESSIONS === 'string' && LINK_SESSIONS.trim() !== ''
    ? path.resolve(LINK_SESSIONS)
    : typeof installState.sessionsRoot === 'string' && installState.sessionsRoot.trim() !== ''
      ? installState.sessionsRoot
      : undefined;
const linkArgs = {
  linkRoot,
  ...(linkSessions ? { sessionsRoot: linkSessions } : {}),
  ...(ALLOW_RUNNING ? { allowWhileRunning: true } : {}),
};

// 回迁放在最前面：失败就停，不能把 preset 和依赖先拆了再发现数据没回来。
let unlinkFailed = false;
if (UNLINK_CONTEXT) {
  log('\n[预处理] 回迁 QQ 会话日志');
  if (ALLOW_RUNNING) {
    log('  ⚠️  --allow-running：DSH 运行中也回迁，只给沙盒/测试用。');
  }
  if (DRY) {
    try {
      const status = await scanContextLinks(linkArgs);
      log(`  (dry) 会回迁 ${status.totals.linked} 个已联通组（${status.totals.bytes} 字节）；未执行`);
    } catch (error) {
      log(`  (dry) 读不到联通状态：${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    try {
      const result = await unlinkContextLinks(linkArgs);
      for (const row of result.results) log(`  ✔ ${row.group}：${row.status}`);
      for (const warning of result.warnings) log(`  ⚠️  ${warning}`);
      for (const error of result.errors) log(`  ✘ ${error.group}：${error.error}`);
      unlinkFailed = !result.ok;
    } catch (error) {
      unlinkFailed = true;
      log(`  ⚠️ 回迁未执行：${error instanceof Error ? error.message : String(error)}`);
    }
    if (unlinkFailed) {
      log(
        '  ⚠️  有会话组没回迁成功，本次卸载到此为止，安装副本和 preset 都保持原样。' +
          '\n     修好后重跑；确认数据已留在联通目录、要强删安装副本：加 --force',
      );
    }
  }
  if (unlinkFailed && !FORCE) {
    log('\n' + '='.repeat(60));
    log('卸载未完成：QQ 会话日志回迁失败，未改动任何安装内容。');
    log('下一步：先托盘完全退出 DSH，再重跑 node uninstall.mjs --unlink-context。');
    process.exit(1);
  }
}

// 不带 --unlink-context 时，只要还有联接或中断残留，就不能删掉唯一能回迁的安装副本。
if (!UNLINK_CONTEXT && !DRY) {
  let status = null;
  try {
    status = await scanContextLinks(linkArgs);
  } catch (error) {
    status = { ok: false, error: error instanceof Error ? error.message : String(error), groups: [] };
  }
  // 扫描失败（会话根读不了等）时 groups 可能是空的：不能当成“没有待回迁数据”。
  if (status === null || !status.ok) {
    const reason = status?.error || '有会话组的联接状态读不出来';
    if (!FORCE) {
      log(`\n⚠️  读不到联通状态：${reason}`);
      log(`    无法确认 QQ 会话日志是否还在 ${linkRoot}，先停在这里，安装未改动。`);
      log('    确认 DSH 已完全退出、--sessions 指向正确的会话根后重跑；确认数据已在联通目录、要强删：加 --force');
      process.exit(1);
    }
    log(`\n⚠️  --force：读不到联通状态（${reason}），未能确认 QQ 会话组是否已回迁；继续卸载。`);
  }
  const blocking = new Set(['linked', 'broken-link', 'linked-elsewhere', 'interrupted', 'error']);
  const pending = (status?.groups ?? []).filter((row) => blocking.has(row.state));
  if (pending.length > 0 && !FORCE) {
    log(`\n⚠️  还有 ${pending.length} 个 QQ 会话组需要处理（联接或中断残留），目标：${linkRoot}。`);
    log('    直接卸载会删掉唯一能回迁的 link-context.mjs，所以先停在这里，安装未改动。');
    log('    先托盘完全退出 DSH，再运行：node uninstall.mjs --unlink-context');
    log('    （确认数据已留在联通目录、要强删：加 --force）');
    process.exit(1);
  }
  if (pending.length > 0) {
    log(`\n⚠️  --force：还有 ${pending.length} 个 QQ 会话组没回迁（目标：${linkRoot}）：`);
    for (const row of pending) log(`    - ${row.group}：${row.state}`);
    log('    继续卸载；数据仍留在上面这个目录，之后用源码目录的 link-context.mjs 回迁。');
  }
}

log('\n[1/5] 还原 QQ preset');
if (REPO) {
  for (const name of PRESETS) restorePreset(path.join(REPO, 'dsh', 'agent-presets', name, 'agent.cordis.yml'));
  log('\n[2/5] 还原 qq-tool-restrict 白名单');
  restoreToolRestrict(REPO);
  log('\n[3/5] 重新生成 bundle patch');
  rebuild(REPO, RUNTIME);
} else {
  log('  ⚠️  找不到 qq-bridge，跳过 preset 还原、白名单还原与 patch 重生成');
}

log('\n[4/5] 从 profile 移除依赖');
if (PROFILE) removeFromProfile(PROFILE, RUNTIME);
else log('  ⚠️  找不到 profile，跳过');

log('\n[5/5] 清理安装副本');
let installRemoved = true;
if (fs.existsSync(installDir)) {
  if (DRY) {
    log(`  (dry) 会删除 ${installDir}`);
  } else {
    try {
      fs.rmSync(installDir, { recursive: true, force: true });
      log(`  ✔ 删除 ${installDir}`);
    } catch (error) {
      installRemoved = false;
      process.exitCode = 1;
      log(`  ❌ 安装副本没删干净：${error?.code ?? (error instanceof Error ? error.message : String(error))}`);
      log(`     剩余文件在 ${installDir}，请换到其它目录重跑，或手动删除。`);
    }
  }
} else {
  log('  · 安装副本不存在');
}
if (unlinkFailed && FORCE) {
  log(`  ⚠️  --force：回迁未完成的数据仍留在 ${linkRoot}`);
}

const memoryDir = path.join(dshHome(), PKG_NAME);
if (PURGE && fs.existsSync(memoryDir)) {
  if (!DRY) fs.rmSync(memoryDir, { recursive: true, force: true });
  log(`  ✔ 删除记忆档案 ${memoryDir}`);
} else if (fs.existsSync(memoryDir)) {
  log(`  · 记忆档案保留在 ${memoryDir}（要一起删：--purge-memory）`);
}

// 逐字节记忆备份是用户数据，不随插件删除。
const memoryBackupRoot =
  typeof installState.memoryBackupRoot === 'string' ? installState.memoryBackupRoot.trim() : '';
if (memoryBackupRoot !== '' && fs.existsSync(memoryBackupRoot)) {
  log(`  · 逐字节记忆备份保留在 ${memoryBackupRoot}（要删自己删）`);
}

try {
  const linkStatus = await scanContextLinks(linkArgs);
  const pendingStates = new Set(['linked', 'broken-link', 'linked-elsewhere', 'interrupted', 'error']);
  const pending = (linkStatus.groups ?? []).filter((row) => pendingStates.has(row.state));
  if (!linkStatus.ok) {
    log(`\n⚠️  联通状态没读全（${linkStatus.error || '有会话组状态读不出来'}），下面可能不是完整列表。`);
  }
  if (pending.length > 0) {
    const sourceCli = path.join(PKG_ROOT, 'link-context.mjs');
    const hint =
      path.resolve(PKG_ROOT) !== path.resolve(installDir) && fs.existsSync(sourceCli)
        ? sourceCli
        : 'ai-love 源码目录里的 link-context.mjs';
    log(
      `\n⚠️  QQ 会话日志仍有 ${pending.length} 个组没回到 C:（目标 ${linkRoot}）：` +
        `\n    ${pending.map((row) => `${row.group}（${row.state}）`).join('、')}` +
        `\n    要回迁：先托盘完全退出 DSH，再运行 node "${hint}" --unlink。`,
    );
  }
} catch (error) {
  // 读不到联通状态不影响卸载，但要让用户知道没核对过。
  log(`\n⚠️  读不到联通状态（${error instanceof Error ? error.message : String(error)}），未能核对 QQ 会话组是否已回迁。`);
}

log('\n' + '='.repeat(60));
log(DRY ? 'dry-run 结束。' : installRemoved ? '卸载完成。' : '卸载未完成：安装副本还有残留，详见上面的提示。');
log('下一步：完整退出 DSH 再打开，然后重启桥接。');
