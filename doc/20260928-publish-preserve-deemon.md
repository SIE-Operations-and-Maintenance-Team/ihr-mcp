# 方案 A+B：发布目录保护与服务安装/卸载恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 subagent-driven-development 按任务实施并逐任务 review；若用户选择当前会话执行，也按相同任务顺序和检查点执行。步骤使用 checkbox（- [ ]）跟踪。
> **执行边界**：本次仅修订实施文档。开始代码实施前须取得用户对本计划的确认；提交须另获人工确认。已授权的一组操作不逐步重复请求许可。
> **状态**：2026-09-28 修订；用户明确选择扩展为 A+B，尚未实施。沿用原文件名，不另外生成平行计划。

**Goal:** 在同一路径就地部署时，防止重新打包删除有效服务的守护与配置，并让安装/卸载能够正确处理 SCM 注册与守护文件不一致的状态；成功、失败和超时均有可验证的结果。

**Architecture:** 共用结构化 SCM 查询、服务路径归属和守护校验。方案 A 在确认服务停止后，将配置和有效守护备份到 stage 外的磁盘目录，执行构建与纯净 ZIP 检查，再通过受控异常流程还原。方案 B 移除按端口强杀进程，按真实注册处理安装、启停和卸载；node-windows 仅负责全新注册，最终结果以 SCM 和管理接口验证为准。

**Tech Stack:** Windows、Node.js ≥20 ESM、node-windows 1.0.0-beta.8（沿用 lockfile）、Windows PowerShell 5.1 / Get-CimInstance、Vitest、TypeScript（tsc 仅覆盖 src）。

**Spec:** doc/bug-diagnosis-service-reinstall-broken-20260928.md，包含第 2、3 轮连续通过的审查结论。本计划覆盖其中 A+B；C 的阻止破坏与操作指引合入发布入口。

## Global Constraints

- 回复、提示和注释使用中文；保留当前仓库风格，业务代码和依赖版本不在本次变更范围。
- **实际服务 ID 为 ihrmcp.exe，显示名称为 ihr-mcp。** 兼容已有 ihr-mcp 注册时读取实际 Name；不再传入无效的 node-windows config.id。
- 查询使用 Win32_Service 的 Name、State、PathName 结构化属性，不搜索 sc qc 整段文本。查询失败、权限错误、输出异常均阻止操作，不能当作“未安装”；无关系统服务的合法空 PathName 可跳过，关联服务缺少路径仍阻止操作。
- ImagePath 解析出的可执行文件须与当前目录的 dist/daemon/ihrmcp.exe **完整路径相等**。不接受目录前缀或参数中包含目标路径作为匹配。
- 相关服务运行、停止中、启动中或状态未知时，publish 在删除前失败并提示先停服。不自动停止服务，不在失败后自动启动。
- config.json / mapping.json 分别按是否存在备份；允许两者独立存在。按字节还原，不打印内容。
- 守护只允许已校验的 ihrmcp.exe、ihrmcp.xml、ihrmcp.exe.config 三个固定文件；不按扩展名收集其他程序。
- ZIP 不含本机 config/mapping、dist/daemon 或备份目录。先生成临时 ZIP，校验及部署数据还原全部成功后才替换最终 ZIP；失败不覆盖已有有效包，并尝试清理本次临时包。
- 将构建中的 process.exit(1) 改为 throw，顶层捕获后设置 process.exitCode。使用 try/finally 覆盖受控构建失败；不以 exit 钩子替代正常控制流。
- 备份先落盘、校验成功，再删除 stage。失败后备份保留；还原失败也不删除备份。强杀、断电不保证自动还原，应用文件不会完整回滚，失败后保持停服。
- 不自动结束占用端口的 PID；无关或归属不明的端口占用应报告冲突并退出。
- 不修改 node_modules；不依据 node-windows 的 install/start/uninstall 事件独自宣告成功。
- 安装/启停/删除的状态等待有期限；查询失败立即失败，超时保留现场并说明需要复核。服务 marked for deletion 仍算未完成删除。
- 本机重打包和服务安装/卸载不得并发执行。实施范围不含跨版本目录迁移、完整应用回滚和强杀后的自动恢复。
- 方案 A 遇到孤立、残缺或路径错误的 daemon 先中止；由方案 B 的明确命令完成恢复后再打包。
- 测试中的服务注册/启停、非测试进程操作和 UAC 调用必须替换；允许原生 CMD 在独立临时目录执行只含固定返回码的 fixture。真实服务验收单独进行，不把模拟测试写成真实服务验收通过。
- 代码实施收口：新增/修改的 mjs 执行 node --check，随后 npm run build 和 npm test；不写死总测试数。
- 只提交本次明确列出的文件，禁止 git add -A 或 git add .。保留 scripts/publish.mjs 已有 daemon 排除改动及其他在途修改。

### 已读取规范与依据

| 来源 | 约束 |
|---|---|
| 用户提供的 AGENTS.md 引用：C:/Users/11013/.claude/CLAUDE.md | 先有实施文档再改代码；最小改动；编译通过；提交需人工确认；新增前 Dedupe Ticket |
| C:/Users/11013/.codex/RTK.md | 实施者执行 shell 命令时使用 rtk；发布给同事的 cmd 内部命令不依赖 rtk |
| writing-plans / rule-aware-planning | 明确接口、实际代码片段、失败测试、验收和规范来源 |
| 当前 package.json / tsconfig.json / vitest.config.ts | Node ≥20、ESM、测试位于 test/**/*.test.ts，mjs 需单独检查 |
| 当前诊断报告 | 区分代码缺陷、历史推断和当前状态；覆盖四种注册/文件组合 |

根目录未发现实体 AGENTS.md 或额外 .Codex/rules、rule、rules、规范目录；使用用户在会话中提供的引用规则。此次只编辑既有文档，不移动 doc 下其他文件。

## 行为决策与范围

| 注册/文件状态 | install | uninstall | publish |
|---|---|---|---|
| 无关联注册、无 daemon | 检查端口，生成并注册，校验后启动 | 幂等成功 | 可打包，独立保留已有配置 |
| 无关联注册、有 daemon | 端口无冲突后，先把孤立 daemon 移到 stage 外备份，再全新安装 | 把孤立 daemon 移到外部备份，幂等成功 | 删除前中止，提示先执行恢复命令 |
| 注册属于本目录、守护完整且正确 | 已运行则验证就绪；已停止则启动；其他状态中止并提示重试 | 按实际 ID 停止、删除并等到注册消失，再移走 daemon | 仅 Stopped 时允许；备份后重建 |
| 注册属于本目录、守护缺失或 XML 错误 | 不覆盖注册；返回失败并指引 uninstall → install | 无须 daemon，即可通过 SCM 停止/删除；等注册消失后隔离残留文件 | 删除前中止，先恢复 |
| 同名注册明确指向其他目录 | 不改注册、不动 daemon、不杀进程，报冲突 | 同左 | 若无注册指向本 stage 且本 stage 无 daemon，可纯净打包；不迁移其他目录服务 |
| 多个指向本目录的注册、相关路径不可可靠解析 | 中止 | 中止 | 删除前中止 |
| SCM 查询失败 | 失败，不执行副作用 | 同左 | 同左 |

“卸载”清除服务注册并把守护移到外部备份，保留 dist 程序、config.json、mapping.json。孤立守护自动隔离是本计划选择的恢复方式；不会自动删除其他目录的服务。

## Dedupe Ticket

- **Intent signature:** 提取 A/B 共用的 SCM/路径判断，再实现 stage 数据保护和服务生命周期控制，供现有脚本调用。
- **Queries（已执行）:** CodeGraph 探索发布/安装/卸载调用链；rg -n 'serviceInstalledFor|backupDaemon|restoreDaemon|Get-CimInstance|execFileSync' scripts src test；rg -n 'daemon|execSync|preserv|restore' scripts test src；rg --files scripts test。
- **Top matches:** scripts/publish.mjs（已有备份和复制流程）；scripts/service-install.mjs（安装前强杀及事件处理）；scripts/service-uninstall.mjs（依赖文件的卸载）；src/web/api.ts（独立网页重启逻辑）；test/config.test.ts（临时文件测试模式）。
- **Decision:** extend 现有发布与服务入口；new 三个职责明确的脚本模块及对应测试。没有可直接复用的 SCM/还原 helper。
- **Rationale:** SCM 判断被发布、安装、卸载共同使用；保护模块负责本地文件；控制模块负责服务生命周期。不是“只有拆模块才能测试”，而是避免三个入口分别实现同一判断。网页重启接口不改行为。

## 文件结构与任务依赖

| 文件 | 操作 | 职责 / 任务 |
|---|---|---|
| scripts/service-state.mjs | 新增 | PowerShell JSON、SCM 归属、守护校验、有限等待；Task 1 |
| test/service-state.test.ts | 新增 | 名称/路径/查询失败/守护/等待；Task 1 |
| scripts/publish-preserve.mjs | 新增 | 磁盘备份、按字节还原、受控失败；Task 2 |
| test/publish-preserve.test.ts | 新增 | 配置独立存在、备份失败、构建失败、还原失败；Task 2 |
| scripts/publish.mjs、publish.cmd | 修改 | 纯净打包、归档验证、还原及退出码；Task 3 |
| test/publish.test.ts | 新增 | 完整发布顺序与失败注入；Task 3 |
| scripts/service-control.mjs | 新增 | 安装、卸载、启停、状态和就绪检查；Task 4 |
| scripts/service-install.mjs、scripts/service-uninstall.mjs | 修改 | 调用共用控制模块的薄入口；Task 4 |
| service-install.cmd、service-uninstall.cmd、ihr-service.cmd | 修改 | 正确传回退出码，管理入口统一状态判断；Task 4 |
| test/service-control.test.ts | 新增 | 四种状态、无强杀、注册失败、等待超时；Task 4 |
| README.md、doc/20260928-publish-exclude-daemon.md | 修改 | 停服→打包→启动、备份与恢复边界；Task 5 |
| doc/bug-diagnosis-service-reinstall-broken-20260928.md | 条件更新 | 仅完成真实验收后追加实施结果；保留历史证据和原 review 记录；Task 5 |

任务顺序：1 → 2 → 3 → 4 → 5。每项结束检查 diff、接口一致性及定向测试；发现新问题先更新本计划再继续。此处所有复选框均表示未来实施，不能因计划完成而勾选。

---

### Task 1: 共用 SCM 与守护校验

**Files:** Create scripts/service-state.mjs；Test test/service-state.test.ts。

**Interfaces:**
- Consumes：Windows Win32_Service、当前部署根目录 root（绝对路径）。
- Produces：powerShellJson(lines, env?, timeoutMs = 10000)；normalizePath(value)；serviceFor(root, rows?, allowForeign = false)；assertDaemon(root, service)；waitForService(root, accept, timeoutMs = 30000)。
- ServiceInfo 的字段固定为 Name、State、PathName；serviceFor 返回 ServiceInfo 或 null，冲突及查询失败抛错。
- waitForService 的 accept 接收 ServiceInfo|null；轮询间隔 200ms。CIM 及每次 sc.exe 查询各最多 10s，完整快照最多包含 3 次查询，因此最后一轮可能使墙钟截止延后最多 30s；截止后不再开始下一轮。测试使用短 deadline 或 fake timers。
- 系统查询返回“无当前注册”前，须对 CIM 未列出的两个候选 ID 用 sc.exe query 确认 1060；1072 作为删除待完成处理，其他错误不能转换成未安装。显式传入 rows 的纯判断测试不执行系统查询。

- [x] **Step 1: 添加失败测试，锁定完整路径与真实 ID。**

~~~typescript
import { afterEach, describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: calls.exec }));
import { serviceFor, waitForService } from '../scripts/service-state.mjs';

const root = 'F:\\deploy\\ihr';
const target = root + '\\dist\\daemon\\ihrmcp.exe';
const row = (PathName = '"' + target + '"', State = 'Stopped') =>
  ({ Name: 'ihrmcp.exe', State, PathName });
afterEach(() => { vi.useRealTimers(); calls.exec.mockReset(); });

describe('serviceFor', () => {
  it('使用真实 ID，允许大小写/斜杠差异', () => {
    expect(serviceFor(root, [row('"F:/DEPLOY/IHR/dist/daemon/ihrmcp.exe"')])?.Name)
      .toBe('ihrmcp.exe');
  });
  it('发布可忽略明确位于其他目录的注册，安装/卸载仍拒绝', () => {
    const foreign = [row('"F:\\other\\ihrmcp.exe"')];
    expect(serviceFor(root, foreign, true)).toBeNull();
    expect(() => serviceFor(root, foreign)).toThrow();
  });
  it('显式传入空快照的纯判断返回 null', () => {
    expect(serviceFor(root, [])).toBeNull();
  });
  it('无关系统服务允许 PathName 为空，不阻断当前部署', () => {
    expect(serviceFor(root, [{ Name: 'UnrelatedSystemService', State: 'Stopped', PathName: null }]))
      .toBeNull();
  });
  it('目标服务 PathName 为空必须拒绝，不能当作未安装', () => {
    expect(() => serviceFor(root, [{ ...row(), PathName: null }])).toThrow();
  });
  it.each([
    '"F:\\other\\ihrmcp.exe" "' + target + '"',
    '"' + root + '\\dist\\daemon-old\\ihrmcp.exe"',
    'F:\\Program Files\\ihrmcp.exe',
  ])('拒绝路径子串/参数伪匹配或歧义路径：%s', path => {
    expect(() => serviceFor(root, [row(path)])).toThrow();
  });
  it('多个注册不能挑第一个继续', () => {
    expect(() => serviceFor(root, [row(), { ...row(), Name: 'ihr-mcp' }])).toThrow();
  });
  it('查询错误不能变成未安装', () => {
    calls.exec.mockImplementation(() => { throw new Error('Access denied'); });
    expect(() => serviceFor(root)).toThrow();
  });
  it('损坏 JSON 不能变成未安装', () => {
    calls.exec.mockReturnValue('not-json');
    expect(() => serviceFor(root)).toThrow();
  });
});

it('等待注册消失有截止时间', async () => {
  calls.exec.mockReturnValue(JSON.stringify([row()]));
  await expect(waitForService(root, service => service === null, 1))
    .rejects.toThrow('超时');
});
it('系统枚举为空后，两个候选 ID 都返回 1060 才确认不存在', () => {
  calls.exec.mockImplementation((_exe, args) => {
    if (args[0] === 'query') throw Object.assign(new Error('not found'), { status: 1060 });
    return '[]';
  });
  expect(serviceFor(root)).toBeNull();
  expect(calls.exec.mock.calls.filter(([_exe, args]) => args[0] === 'query')).toHaveLength(2);
});
it.each([0, 5, 1072])('空枚举但按名称查询返回 %s，不能判未安装', status => {
  calls.exec.mockImplementation((_exe, args) => {
    if (args[0] !== 'query') return '[]';
    if (status !== 0) throw Object.assign(new Error('query result'), { status });
    return 'service still exists';
  });
  expect(() => serviceFor(root)).toThrow();
});
it('1072 删除待完成继续等待，随后 1060 才结束', async () => {
  let rounds = 0;
  calls.exec.mockImplementation((_exe, args) => {
    if (args[0] !== 'query') { rounds++; return '[]'; }
    throw Object.assign(new Error('query result'), { status: rounds === 1 ? 1072 : 1060 });
  });
  await expect(waitForService(root, service => service === null, 2000)).resolves.toBeNull();
  expect(rounds).toBeGreaterThan(1);
});
~~~

Run：rtk npm test -- test/service-state.test.ts。Expected：新增模块尚不存在时失败，不能是测试语法错误。

- [x] **Step 2: 实现结构化查询、路径判断与有限等待。**

以下代码为 scripts/service-state.mjs 的完整基础部分；Step 3 在同文件追加守护校验。

~~~javascript
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const candidateNames = new Set(['ihrmcp.exe', 'ihr-mcp']);

export function normalizePath(value) {
  if (typeof value !== 'string' || !win32.isAbsolute(value)) {
    throw new Error('需要明确的 Windows 绝对路径');
  }
  return win32.normalize(value).replaceAll('/', '\\').toLowerCase();
}

export function powerShellJson(lines, env = {}, timeoutMs = 10000) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
    ...lines,
  ].join('\n');
  const executable = join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let output;
  try {
    output = execFileSync(executable, [
      '-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ], {
      encoding: 'utf8', windowsHide: true, timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...env },
    });
  } catch (error) {
    throw new Error('Windows 查询/归档命令失败，退出码：' + (error.status ?? '未知')
      + '；请检查权限、输入格式或超时', { cause: error });
  }
  try { return JSON.parse(output.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Windows 命令未返回有效 JSON'); }
}

function executableOf(command) {
  if (typeof command !== 'string') return null;
  const match = command.trim().match(/^"([^"]+)"(?:\s.*)?$/)
    || command.trim().match(/^([^\s"]+\.exe)(?:\s.*)?$/i);
  if (!match) return null;
  try { return normalizePath(match[1]); } catch { return null; }
}

export function serviceFor(root, rows, allowForeign = false) {
  const expected = normalizePath(join(root, 'dist', 'daemon', 'ihrmcp.exe'));
  const directory = normalizePath(root) + '\\';
  const queriedSystem = rows === undefined;
  if (rows === undefined) {
    rows = powerShellJson([
      '$items = @(Get-CimInstance Win32_Service -ErrorAction Stop | Select-Object Name, State, PathName)',
      'ConvertTo-Json -InputObject $items -Compress -Depth 3',
    ]);
  }
  if (!Array.isArray(rows)) throw new Error('SCM 查询结果必须为数组');
  const related = [];
  for (const service of rows) {
    if (!service || typeof service.Name !== 'string') {
      throw new Error('SCM 查询结果字段不完整');
    }
    const exe = executableOf(service.PathName);
    const named = candidateNames.has(service.Name.toLowerCase());
    const underRoot = exe !== null && exe.startsWith(directory);
    const referencesRoot = typeof service.PathName === 'string'
      && service.PathName.replaceAll('/', '\\').toLowerCase().includes(directory);
    if (!named && !underRoot && !referencesRoot) continue;
    if (typeof service.State !== 'string' || typeof service.PathName !== 'string') {
      throw new Error('关联服务的状态或路径缺失，不能继续操作');
    }
    if (allowForeign && named && exe !== null && !underRoot && !referencesRoot) continue;
    if (!named || exe !== expected) {
      throw new Error('服务注册与目标部署目录冲突：' + service.Name);
    }
    related.push(service);
  }
  if (related.length > 1) throw new Error('发现多个关联服务，先明确部署归属');
  if (queriedSystem && related.length === 0) {
    for (const name of candidateNames) {
      if (rows.some(row => row.Name.toLowerCase() === name)) continue;
      try {
        execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'sc.exe'),
          ['query', name], { encoding: 'utf8', windowsHide: true, timeout: 10000,
            stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        if (error.status === 1060) continue;
        if (error.status === 1072) {
          const pending = new Error('服务正在删除，需等待 SCM 注册完全消失：' + name);
          pending.code = 'SERVICE_DELETE_PENDING';
          throw pending;
        }
        throw new Error('无法确认服务是否不存在：' + name, { cause: error });
      }
      throw new Error('SCM 枚举与按名称查询不一致，请重新核对：' + name);
    }
  }
  return related[0] || null;
}

export async function waitForService(root, accept, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      const current = serviceFor(root);
      if (accept(current)) return current;
    } catch (error) {
      if (error.code !== 'SERVICE_DELETE_PENDING') throw error;
    }
    if (Date.now() >= deadline) break;
    await delay(Math.min(200, deadline - Date.now()));
  } while (Date.now() <= deadline);
  throw new Error('等待服务状态超时，请复核 SCM 状态及是否仍有服务管理窗口占用');
}
~~~

不把来自 SCM 的任意命令串拿去执行；仅提取可执行文件路径做判断。查询覆盖全部服务，能发现同一 root 下使用其他 ID 的注册并中止；本方案不自动迁移这些服务。allowForeign 只供发布调用：可明确解析且位于 root 外的候选注册不属于本次重建对象，不阻止为新版本目录生成纯净包；安装/卸载始终使用默认严格模式。

- [x] **Step 3: 追加守护完整性与 XML 路径校验。**

~~~javascript
export function assertDaemon(root, service) {
  const daemon = join(root, 'dist', 'daemon');
  for (const name of ['ihrmcp.exe', 'ihrmcp.xml', 'ihrmcp.exe.config']) {
    const path = join(daemon, name);
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error('守护文件缺失或不是普通文件，请先卸载后重装：' + path);
    }
  }
  const xml = powerShellJson([
    '$doc = [xml](Get-Content -LiteralPath $env:IHR_DAEMON_XML -Raw -Encoding UTF8)',
    '$value = [pscustomobject]@{',
    '  Id = [string]$doc.service.id',
    '  Executable = [string]$doc.service.executable',
    '  WorkingDirectory = [string]$doc.service.workingdirectory',
    '  Arguments = @($doc.service.argument | ForEach-Object { [string]$_ })',
    '}',
    'ConvertTo-Json -InputObject $value -Compress -Depth 4',
  ], { IHR_DAEMON_XML: join(daemon, 'ihrmcp.xml') });
  const args = xml.Arguments;
  const index = Array.isArray(args) ? args.indexOf('--file') : -1;
  const wrapper = normalizePath(join(root, 'node_modules', 'node-windows', 'lib', 'wrapper.js'));
  const wrapperIndex = Array.isArray(args) ? args.findIndex(value => {
    try { return normalizePath(value) === wrapper; } catch { return false; }
  }) : -1;
  if (String(xml.Id).toLowerCase() !== service.Name.toLowerCase() || index < 0 || index !== args.lastIndexOf('--file')
      || wrapperIndex < 0 || wrapperIndex >= index
      || normalizePath(args[index + 1]) !== normalizePath(join(root, 'dist', 'index.js'))
      || normalizePath(xml.WorkingDirectory) !== normalizePath(root)) {
    throw new Error('守护 XML 与当前注册/部署路径不一致，请先卸载后重装');
  }
  for (const path of [
    xml.Executable, join(root, 'dist', 'index.js'),
    join(root, 'node_modules', 'node-windows', 'lib', 'wrapper.js'),
  ]) {
    normalizePath(path);
    if (!existsSync(path) || !lstatSync(path).isFile()) {
      throw new Error('守护引用的运行文件不存在：' + path);
    }
  }
}
~~~

- [x] **Step 4: 补充真实临时文件 + XML 查询替身测试。**

在 test/service-state.test.ts 加入以下 import 与用例；临时目录用 finally 清理，删除前校验归属。

~~~typescript
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { assertDaemon } from '../scripts/service-state.mjs';

it('守护完整且 XML 路径吻合才通过；错脚本或缺文件均拒绝', () => {
  const folder = mkdtempSync(join(tmpdir(), 'ihr-state-test-'));
  try {
    for (const rel of [
      'dist/daemon/ihrmcp.exe', 'dist/daemon/ihrmcp.xml', 'dist/daemon/ihrmcp.exe.config',
      'dist/index.js', 'node_modules/node-windows/lib/wrapper.js',
    ]) {
      const path = join(folder, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, 'fixture');
    }
    const record = {
      Name: 'ihrmcp.exe', State: 'Stopped',
      PathName: '"' + join(folder, 'dist/daemon/ihrmcp.exe') + '"',
    };
    const config = {
      Id: record.Name, Executable: process.execPath, WorkingDirectory: folder,
      Arguments: [join(folder, 'node_modules/node-windows/lib/wrapper.js'),
        '--file', join(folder, 'dist/index.js'), '--scriptoptions=-t http'],
    };
    calls.exec.mockReturnValue(JSON.stringify(config));
    expect(() => assertDaemon(folder, record)).not.toThrow();
    calls.exec.mockReturnValue(JSON.stringify({
      ...config, Arguments: [config.Arguments[0], '--file', 'F:\\other\\index.js'],
    }));
    expect(() => assertDaemon(folder, record)).toThrow();
    calls.exec.mockReturnValue(JSON.stringify(config));
    rmSync(join(folder, 'dist/daemon/ihrmcp.exe.config'));
    expect(() => assertDaemon(folder, record)).toThrow('守护文件缺失');
  } finally {
    const full = resolve(folder);
    if (!full.startsWith(resolve(tmpdir()) + sep)) throw new Error('临时目录越界');
    rmSync(full, { recursive: true, force: true });
  }
});
~~~

- [x] **Step 5: 定向检查并 review 接口。**

~~~powershell
rtk proxy node --check scripts/service-state.mjs
rtk npm test -- test/service-state.test.ts
~~~

Expected：全部通过；没有执行真实 SCM 修改。记录实际用例数，不预设固定数量。此任务不提交，统一在 Task 5 获用户提交授权后进行。

**检查点记录（2026-09-28）：** Task 1 实现与定向验证完成，18 项测试通过，未修改真实 SCM。测试与模块在同一编辑批次加入，未单独先运行模块缺失时的红测；不影响后续接口。代码审查确认路径需完整相等、查询异常会阻止操作，Task 2 仍可按既定接口继续。

---

### Task 2: 磁盘备份、还原与发布保护区间

**Files:** Create scripts/publish-preserve.mjs；Test test/publish-preserve.test.ts。

**Interfaces:**
- Consumes：Task 1 的 serviceFor、assertDaemon、normalizePath。
- Produces：withPreservedDeployment(root, build) → { value, backupDir }；restoreBackup(root, backupDir) → void。
- build 是同步函数；只允许返回值或抛错，不允许 process.exit、后台写文件或启动服务。
- backupDir 为 stage 同级的 .ihr-deploy-backup-* 目录，包含 manifest.json 与 files/。成功后也保留备份并输出位置，待操作者确认后清理，不自动递归删除备份。

- [x] **Step 1: 添加覆盖正常还原与失败还原的测试。**

~~~typescript
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync,
  readdirSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const state = vi.hoisted(() => ({ find: vi.fn(), validate: vi.fn() }));
vi.mock('../scripts/service-state.mjs', async importOriginal => ({
  ...(await importOriginal<object>()), serviceFor: state.find, assertDaemon: state.validate,
}));
import { withPreservedDeployment, restoreBackup } from '../scripts/publish-preserve.mjs';

let base: string, stage: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ihr-preserve-test-'));
  stage = join(base, 'stage');
  mkdirSync(stage);
  state.find.mockReset().mockReturnValue(null);
  state.validate.mockReset();
});
afterEach(() => {
  const full = resolve(base);
  if (!full.startsWith(resolve(tmpdir()) + sep)) throw new Error('临时目录越界');
  rmSync(full, { recursive: true, force: true });
});
function replaceStage() {
  if (dirname(resolve(stage)) !== resolve(base)) throw new Error('stage 越界');
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage);
}
function put(rel: string, value = 'original') {
  const path = join(stage, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

it.each([['config.json'], ['mapping.json'], ['config.json', 'mapping.json']])(
  '配置独立备份并按字节还原：%j', (...names: string[]) => {
    const original = Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0d, 0x0a]);
    for (const name of names) writeFileSync(join(stage, name), original);
    const result = withPreservedDeployment(stage, replaceStage);
    for (const name of names) expect(readFileSync(join(stage, name))).toEqual(original);
    expect(existsSync(join(result.backupDir!, 'manifest.json'))).toBe(true);
  },
);
it('只有停止且有效的服务守护被保留，日志和其他 exe 不保留', () => {
  state.find.mockReturnValue({ Name: 'ihrmcp.exe', State: 'Stopped' });
  for (const name of ['ihrmcp.exe', 'ihrmcp.xml', 'ihrmcp.exe.config', 'other.exe', 'ihrmcp.out.log'])
    put('dist/daemon/' + name);
  withPreservedDeployment(stage, replaceStage);
  expect(readdirSync(join(stage, 'dist/daemon')).sort())
    .toEqual(['ihrmcp.exe', 'ihrmcp.exe.config', 'ihrmcp.xml']);
});
it.each(['Running', 'Start Pending', 'Stop Pending'])('状态 %s 时不执行构建', status => {
  state.find.mockReturnValue({ Name: 'ihrmcp.exe', State: status });
  const build = vi.fn();
  expect(() => withPreservedDeployment(stage, build)).toThrow('先停止');
  expect(build).not.toHaveBeenCalled();
});
it('孤立 daemon 必须先恢复，不能静默丢弃', () => {
  put('dist/daemon/ihrmcp.exe');
  const build = vi.fn();
  expect(() => withPreservedDeployment(stage, build)).toThrow('孤立');
  expect(build).not.toHaveBeenCalled();
  expect(existsSync(join(stage, 'dist/daemon/ihrmcp.exe'))).toBe(true);
});
it('配置不是普通文件时在删除前失败', () => {
  mkdirSync(join(stage, 'config.json'));
  const build = vi.fn();
  expect(() => withPreservedDeployment(stage, build)).toThrow();
  expect(build).not.toHaveBeenCalled();
});
it.each(['npm ci 失败', '压缩失败', '自检失败'])('%s 后仍还原配置', message => {
  put('config.json', 'original');
  expect(() => withPreservedDeployment(stage, () => {
    replaceStage();
    throw new Error(message);
  })).toThrow(message);
  expect(readFileSync(join(stage, 'config.json'), 'utf8')).toBe('original');
});
it('一项还原失败仍尝试其他项，磁盘备份可用于重试', () => {
  put('config.json', 'cfg');
  put('mapping.json', 'map');
  expect(() => withPreservedDeployment(stage, () => {
    replaceStage();
    mkdirSync(join(stage, 'config.json')); // 制造写入失败，不修改权限
  })).toThrow('还原失败');
  expect(readFileSync(join(stage, 'mapping.json'), 'utf8')).toBe('map');
  const backup = join(base, readdirSync(base).find(name => name.startsWith('.ihr-deploy-backup-'))!);
  expect(existsSync(join(backup, 'manifest.json'))).toBe(true);
  rmSync(join(stage, 'config.json'), { recursive: true }); // 目标已确定在 fixture 内
  restoreBackup(stage, backup);
  restoreBackup(stage, backup);
  expect(readFileSync(join(stage, 'config.json'), 'utf8')).toBe('cfg');
});
~~~

Run：rtk npm test -- test/publish-preserve.test.ts。Expected：先因模块不存在失败。

- [x] **Step 2: 实现完整保护模块。**

~~~javascript
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { serviceFor, assertDaemon, normalizePath } from './service-state.mjs';

const localFiles = ['config.json', 'mapping.json'];
const daemonFiles = [
  'dist/daemon/ihrmcp.exe', 'dist/daemon/ihrmcp.xml', 'dist/daemon/ihrmcp.exe.config',
];
const allowed = new Set([...localFiles, ...daemonFiles]);
const digest = value => createHash('sha256').update(value).digest('hex');

function createBackup(root, files) {
  mkdirSync(dirname(root), { recursive: true });
  const backupDir = mkdtempSync(join(dirname(root), '.ihr-deploy-backup-'));
  try {
    const entries = [];
    for (const rel of files) {
      const source = join(root, rel);
      if (!lstatSync(source).isFile()) throw new Error('不能备份非普通文件：' + source);
      const bytes = readFileSync(source);
      const target = join(backupDir, 'files', rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      if (!readFileSync(target).equals(bytes)) throw new Error('备份校验失败：' + rel);
      entries.push({ rel, sha256: digest(bytes) });
    }
    writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify({
      root: resolve(root), entries,
    }, null, 2), 'utf8'); // 最后写清单；此前失败不可进入构建
    return backupDir;
  } catch (error) {
    throw new Error('备份失败，原部署未重建；检查 ' + backupDir, { cause: error });
  }
}

export function restoreBackup(root, backupDir) {
  const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'));
  if (normalizePath(manifest.root) !== normalizePath(root)
      || !Array.isArray(manifest.entries)
      || manifest.entries.some(entry => !allowed.has(entry.rel)
        || !/^[0-9a-f]{64}$/.test(entry.sha256))
      || new Set(manifest.entries.map(entry => entry.rel)).size !== manifest.entries.length) {
    throw new Error('备份清单与目标部署不匹配');
  }
  const errors = [];
  for (const entry of manifest.entries) {
    try {
      const bytes = readFileSync(join(backupDir, 'files', entry.rel));
      if (digest(bytes) !== entry.sha256) throw new Error('备份内容校验失败：' + entry.rel);
      const target = join(root, entry.rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      if (!readFileSync(target).equals(bytes)) throw new Error('还原校验失败：' + entry.rel);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, '还原失败，保持停服，备份保留在 ' + backupDir);
  }
}

export function withPreservedDeployment(root, build) {
  root = resolve(root);
  const service = serviceFor(root, undefined, true);
  const daemonDir = join(root, 'dist', 'daemon');
  if (service && service.State !== 'Stopped') {
    throw new Error('请先停止服务并确认 Stopped：' + service.Name);
  }
  if (!service && existsSync(daemonDir)) {
    throw new Error('发现孤立 daemon，请先使用 service-uninstall.cmd 处理残留');
  }
  if (service) assertDaemon(root, service);
  const files = localFiles.filter(rel => existsSync(join(root, rel)));
  if (service) files.push(...daemonFiles);
  for (const rel of files) {
    if (!lstatSync(join(root, rel)).isFile()) throw new Error('部署文件不是普通文件：' + rel);
  }
  const backupDir = files.length ? createBackup(root, files) : null;
  let value, buildError, restoreError;
  try {
    value = build();
  } catch (error) {
    buildError = error;
  } finally {
    if (backupDir) {
      try { restoreBackup(root, backupDir); } catch (error) { restoreError = error; }
    }
  }
  if (restoreError) {
    throw new AggregateError([buildError, restoreError].filter(Boolean),
      '还原失败，保持停服，备份保留在 ' + backupDir);
  }
  if (buildError) {
    throw new Error(buildError.message + '；部署可能不完整，保持停服；备份：'
      + (backupDir || '原目录无待保留文件'), { cause: buildError });
  }
  return { value, backupDir };
}
~~~

还原不再次调用 SCM 决定是否“跳过”，避免构建后一次查询故障把已经备份的文件丢掉；前置条件要求这段流程期间不并发安装、卸载或启停。还原不先删整个 daemon，避免失败时再次破坏已写回的文件。

- [x] **Step 3: 执行定向测试与代码检查。**

~~~powershell
rtk proxy node --check scripts/publish-preserve.mjs
rtk npm test -- test/publish-preserve.test.ts test/service-state.test.ts
~~~

Expected：配置独立存在、三类构建失败、还原失败后重试均通过。备份校验与 restoreBackup 的重复调用不打印配置内容。

**检查点记录（2026-09-28）：** Task 2 实现与定向验证完成；两个测试文件共 31 项通过。审查确认有效 daemon 仅按固定清单备份，备份校验后才调用构建，失败时配置仍恢复且备份保留。测试和实现同一编辑批次加入，未先单独运行缺模块红测；Task 3 接口和顺序无需调整。

---

### Task 3: 发布流程接入、纯净 ZIP 验证与退出码

**Files:** Modify scripts/publish.mjs、publish.cmd；Create test/publish.test.ts。

**Interfaces:**
- Consumes：withPreservedDeployment(root, build)、powerShellJson(lines, env)。
- Produces：publish(repoRoot) → zipPath；导入模块不执行发布，直接运行脚本才调用 publish。
- 改造后的命令行入口只设置 process.exitCode，不在保护区内 process.exit。

- [x] **Step 0: 先隔离旧脚本的导入副作用，再运行红测。**

当前 scripts/publish.mjs 是顶层执行脚本。Vitest 会求值导入的模块，缺少 publish 导出不会阻止其先删除真实 stage，因此禁止直接对旧脚本执行下面的测试。代码实施获授权后，先执行以下一次性结构变换：原构建主体保留，包入 publish(repoRoot)，显式退出改为抛错，只有直接运行入口才发布。此步不添加保护逻辑，后续红测仍应发现旧还原行为的缺陷。

在项目根目录用 Node ESM 执行以下代码；如入口已被重构，人工核对其确实无导入副作用后跳过此变换，不重复套一层函数。

~~~js
import { readFileSync, writeFileSync } from 'node:fs';
const file = 'scripts/publish.mjs';
const source = readFileSync(file, 'utf8');
const anchor = "const root = join(dirname(fileURLToPath(import.meta.url)), '..');";
if (source.includes('export function publish(')) throw new Error('入口已经重构，请核对后跳过变换');
const at = source.indexOf(anchor);
if (at < 0 || source.indexOf(anchor, at + 1) !== -1) throw new Error('原脚本锚点不唯一，停止变换');
const imports = source.slice(0, at)
  .replace("import { fileURLToPath } from 'node:url';",
    "import { fileURLToPath, pathToFileURL } from 'node:url';")
  .replace("import { dirname, join } from 'node:path';",
    "import { dirname, join, resolve } from 'node:path';");
const body = source.slice(at + anchor.length)
  .replaceAll('process.exit(1);', "throw new Error('发布校验失败');");
const tail = [
  '}',
  'if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {',
  "  try { publish(join(dirname(fileURLToPath(import.meta.url)), '..')); }",
  "  catch (error) { console.error('[错误] ' + error.message); process.exitCode = 1; }",
  '}',
].join('\n');
writeFileSync(file, imports + 'export function publish(repoRoot) {\n'
  + 'const root = resolve(repoRoot);\n' + body + '\n' + tail + '\n', 'utf8');
~~~

先运行 rtk proxy node --check scripts/publish.mjs。检查导入时不会执行 rmSync、npm 或压缩后，才进入 Step 1。审查已在临时旧脚本副本中复现过“测试收集期间删除 stage”的风险；不得把该复现移到真实部署目录。

- [x] **Step 1: 写发布整链路测试，外部命令全部替换。**

~~~typescript
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const external = vi.hoisted(() => ({ npm: vi.fn(), ps: vi.fn() }));
vi.mock('node:child_process', () => ({ execSync: external.npm, execFileSync: vi.fn() }));
vi.mock('../scripts/service-state.mjs', async importOriginal => ({
  ...(await importOriginal<object>()),
  serviceFor: () => null,
  powerShellJson: external.ps,
}));
import { publish } from '../scripts/publish.mjs';

let root: string, stage: string;
function put(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ihr-publish-test-'));
  stage = join(root, 'publish', 'ihr-mcp-v0.1.0');
  put(join(root, 'package.json'), JSON.stringify({ version: '0.1.0' }));
  put(join(root, 'package-lock.json'), '{}');
  put(join(root, 'dist/index.js'), 'new-code');
  put(join(root, 'dist/daemon/ihrmcp.xml'), 'repo-daemon');
  put(join(root, 'scripts/service-install.mjs'), 'script');
  put(join(root, 'skill/example.txt'), 'skill');
  for (const file of ['service-install.cmd', 'service-uninstall.cmd', 'ihr-service.cmd'])
    put(join(root, file), 'cmd');
  put(join(stage, 'config.json'), 'deployed-config');
  external.npm.mockReset().mockImplementation(() => {
    put(join(stage, 'node_modules/node-windows/package.json'), '{}');
  });
  external.ps.mockReset().mockImplementation((_lines, env) => {
    expect(existsSync(join(stage, 'config.json'))).toBe(false);
    expect(existsSync(join(stage, 'dist/daemon'))).toBe(false);
    writeFileSync(env.IHR_PUBLISH_ZIP, 'fake-zip');
    return true;
  });
});
afterEach(() => {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('临时目录越界');
  rmSync(root, { recursive: true, force: true });
});

it('先生成纯净包，之后还原配置', () => {
  expect(publish(root)).toBe(join(root, 'publish/ihr-mcp-v0.1.0.zip'));
  expect(readFileSync(join(stage, 'config.json'), 'utf8')).toBe('deployed-config');
  expect(existsSync(join(stage, 'dist/daemon'))).toBe(false);
});
it('成功后才用新包替换旧有效 ZIP', () => {
  const finalZip = join(root, 'publish/ihr-mcp-v0.1.0.zip');
  writeFileSync(finalZip, 'old-valid-zip');
  publish(root);
  expect(readFileSync(finalZip, 'utf8')).toBe('fake-zip');
  expect(existsSync(join(root, 'publish/ihr-mcp-v0.1.0.pending.zip'))).toBe(false);
});
it.each(['npm', 'zip', 'self-check'])('%s 失败也还原配置且抛错', phase => {
  if (phase === 'npm') external.npm.mockImplementation(() => { throw new Error('npm failed'); });
  if (phase === 'zip') external.ps.mockImplementation(() => { throw new Error('zip failed'); });
  if (phase === 'self-check') external.npm.mockImplementation(() => {});
  expect(() => publish(root)).toThrow();
  expect(readFileSync(join(stage, 'config.json'), 'utf8')).toBe('deployed-config');
});
it.each([false, true])('ZIP 校验失败不发布坏包，保留旧包=%s', hadOldZip => {
  const finalZip = join(root, 'publish/ihr-mcp-v0.1.0.zip');
  if (hadOldZip) writeFileSync(finalZip, 'old-valid-zip');
  external.ps.mockImplementation((_lines, env) => {
    writeFileSync(env.IHR_PUBLISH_ZIP, 'invalid-archive');
    throw new Error('archive verification failed');
  });
  expect(() => publish(root)).toThrow();
  if (hadOldZip) expect(readFileSync(finalZip, 'utf8')).toBe('old-valid-zip');
  else expect(existsSync(finalZip)).toBe(false);
  expect(existsSync(join(root, 'publish/ihr-mcp-v0.1.0.pending.zip'))).toBe(false);
});
it('部署文件还原失败时也不能替换最终 ZIP', () => {
  external.ps.mockImplementation((_lines, env) => {
    writeFileSync(env.IHR_PUBLISH_ZIP, 'valid-temp-zip');
    mkdirSync(join(stage, 'config.json'));
    return true;
  });
  expect(() => publish(root)).toThrow('还原失败');
  expect(existsSync(join(root, 'publish/ihr-mcp-v0.1.0.zip'))).toBe(false);
  expect(existsSync(join(root, 'publish/ihr-mcp-v0.1.0.pending.zip'))).toBe(false);
});
~~~

Run：rtk npm test -- test/publish.test.ts。必须先完成 Step 0；此时应因旧流程自检/失败还原行为不符合断言而失败，不能是 process.exit 杀掉 worker、导入副作用或语法错误。测试只重建 fixture 目录，mock 的 ZIP 只验证顺序，实际归档内容由 Task 5 真实压缩验收。

- [x] **Step 2: 替换 scripts/publish.mjs 为可测试入口。**

~~~javascript
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { withPreservedDeployment } from './publish-preserve.mjs';
import { powerShellJson, normalizePath } from './service-state.mjs';

export function publish(repoRoot) {
  const root = resolve(repoRoot);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!/^[0-9A-Za-z.+-]+$/.test(pkg.version)) throw new Error('版本号不能构成目录路径');
  if (!existsSync(join(root, 'dist', 'index.js'))) throw new Error('请先执行 npm run build');
  const name = 'ihr-mcp-v' + pkg.version;
  const stage = join(root, 'publish', name);
  const zipPath = join(root, 'publish', name + '.zip');
  const pendingZip = join(root, 'publish', name + '.pending.zip');
  if (!normalizePath(stage).startsWith(normalizePath(join(root, 'publish')) + '\\')) {
    throw new Error('发布目录越界');
  }
  let outcome;
  try {
    outcome = withPreservedDeployment(stage, () => {
    // 失败就退出保护区并还原，不在部分删除后再无条件清空每一个条目。
    rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    rmSync(pendingZip, { force: true, maxRetries: 5, retryDelay: 200 });
    mkdirSync(join(stage, 'dist'), { recursive: true });
    cpSync(join(root, 'dist'), join(stage, 'dist'), {
      recursive: true,
      filter: src => {
        const rel = src.slice(root.length).replaceAll('\\', '/');
        return !/^\/dist\/daemon(\/|$)/.test(rel)
          && !src.endsWith('config.json') && !src.endsWith('mapping.json');
      },
    });
    for (const name of ['package.json', 'package-lock.json'])
      cpSync(join(root, name), join(stage, name));
    execSync('npm ci --omit=dev', { cwd: stage, stdio: 'inherit', windowsHide: true });
    cpSync(join(root, 'scripts'), join(stage, 'scripts'), { recursive: true });
    for (const name of ['service-install.cmd', 'service-uninstall.cmd', 'ihr-service.cmd'])
      cpSync(join(root, name), join(stage, name));
    cpSync(join(root, 'skill'), join(stage, 'skill'), { recursive: true });

    for (const rel of ['node_modules/node-windows', 'dist/index.js', 'service-install.cmd']) {
      if (!existsSync(join(stage, rel))) throw new Error('发布包缺少 ' + rel);
    }
    for (const rel of ['config.json', 'mapping.json', 'dist/daemon', 'node_modules/typescript']) {
      if (existsSync(join(stage, rel))) throw new Error('发布包混入本机文件或开发依赖：' + rel);
    }
    powerShellJson([
      '$paths = @(Get-ChildItem -LiteralPath $env:IHR_PUBLISH_STAGE | Select-Object -ExpandProperty FullName)',
      'Compress-Archive -LiteralPath $paths -DestinationPath $env:IHR_PUBLISH_ZIP -Force -ErrorAction Stop',
      'Add-Type -AssemblyName System.IO.Compression.FileSystem',
      '$archive = [System.IO.Compression.ZipFile]::OpenRead($env:IHR_PUBLISH_ZIP)',
      'try {',
      '  $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace("\\", "/") })',
      '  if ($names | Where-Object { $_ -match "^(config\\.json|mapping\\.json)$|^dist/daemon(/|$)|^node_modules/typescript(/|$)" }) { throw "ZIP contains local data or dev dependencies" }',
      '  foreach ($required in @("dist/index.js", "service-install.cmd", "node_modules/node-windows/package.json")) {',
      '    if ($names -notcontains $required) { throw ("ZIP missing " + $required) }',
      '  }',
      '} finally { $archive.Dispose() }',
      'ConvertTo-Json -InputObject $true',
    ], { IHR_PUBLISH_STAGE: stage, IHR_PUBLISH_ZIP: pendingZip }, 120000);
    return pendingZip;
    });
    // 仅在归档校验和部署还原均成功后发布最终文件；不预先删除旧有效包。
    renameSync(pendingZip, zipPath);
  } catch (error) {
    try { rmSync(pendingZip, { force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError],
        '发布失败且临时 ZIP 清理失败，禁止分发：' + pendingZip);
    }
    throw error;
  }
  console.log('[完成] 发布包：' + zipPath);
  if (outcome.backupDir) console.log('[说明] 部署备份：' + outcome.backupDir);
  console.log('[说明] 原服务保持停止；确认发布成功后执行 ihr-service.cmd start。');
  console.log('[说明] 同事解压后运行 service-install.cmd；需 Node.js ≥20；本机配置未进入 ZIP。');
  console.log('[说明] 考勤 skill 源在包内 skill/ihr-attendance，按所用 agent 的技能目录安装。');
  return zipPath;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { publish(join(dirname(fileURLToPath(import.meta.url)), '..')); }
  catch (error) {
    console.error('[错误] ' + error.message);
    process.exitCode = 1;
  }
}
~~~

压缩调用显式使用 120000ms 超时；SCM/XML 使用 Task 1 helper 默认的 10000ms。命令超时属于构建失败，不能输出发布成功。

- [x] **Step 3: publish.cmd 保留 Node 退出码。**

用下列内容替换现有 cmd（保持 CRLF），不把 pause 的结果当作发布结果：

~~~bat
@echo off
chcp 65001 >nul
setlocal
title ihr-mcp 离线发布包打包
cd /d "%~dp0"
node scripts\publish.mjs
set "IHR_TASK_EXIT=%errorlevel%"
echo.
pause
exit /b %IHR_TASK_EXIT%
~~~

- [x] **Step 4: 验证保护顺序和编译。**

~~~powershell
rtk proxy node --check scripts/publish.mjs
rtk npm test -- test/publish.test.ts test/publish-preserve.test.ts test/service-state.test.ts
rtk npm run build
~~~

Expected：构建正常路径退出 0，异常路径退出非零；配置还原发生在 ZIP 检查之后。移除 rmSync 失败后的第二轮逐项删除后，占用问题会明确失败并保留备份，不伪装成功。不在开发机现有 publish 目录上用真实发布代替这些测试。

**检查点记录（2026-09-28）：** Task 3 完成；定向测试 39 项通过，`npm run build` 通过。代码审查确认模块导入无发布副作用、源 daemon 排除保留、临时 ZIP 在 ZIP 验证及本机数据还原成功后才替换最终包。未在仓库现有 publish 目录执行真实发布；Task 4 不依赖发布入口内部实现，无计划调整。

---

### Task 4: 安装、卸载和服务管理统一真实状态

**Files:** Create scripts/service-control.mjs、test/service-control.test.ts；Modify scripts/service-install.mjs、scripts/service-uninstall.mjs、service-install.cmd、service-uninstall.cmd、ihr-service.cmd。

**Interfaces:**
- Consumes：serviceFor、assertDaemon、waitForService、normalizePath。
- Produces：installService(root)、uninstallService(root)、startService(root)、stopService(root)、manageService(root, action)，均返回 Promise。
- manageService 支持 install/uninstall/start/stop/restart/status，根目录来自脚本位置；所有系统命令使用参数数组。
- 全新注册使用有 30s 执行超时的独立 Node 子进程调用 node-windows；其输出不直接作为成功凭据，也不打印依赖内部生成的配置调试输出。子进程超时可能留下已创建的注册，保留现场并报告，而非自动删除。
- 状态轮询 30s、每个 SCM 命令 10s、单次管理接口请求 1s；最后一轮完整 SCM 快照最多包含 3 次查询，墙钟截止允许相应有限延后。服务就绪还需 /api/config 返回的 configPath 指向当前部署目录。

- [x] **Step 1: 写失败测试，先验证四种状态与无副作用顺序。**

~~~typescript
import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const deps = vi.hoisted(() => ({
  current: null as any, queryError: null as Error | null, valid: vi.fn(), exec: vi.fn(),
  wait: vi.fn(), portBusy: false, trace: [] as string[],
}));
vi.mock('../scripts/service-state.mjs', async importOriginal => ({
  ...(await importOriginal<object>()),
  serviceFor: () => {
    deps.trace.push('query');
    if (deps.queryError) throw deps.queryError;
    return deps.current;
  },
  assertDaemon: deps.valid,
  waitForService: deps.wait,
}));
vi.mock('node:child_process', () => ({ execFileSync: deps.exec }));
vi.mock('node:net', () => ({
  createServer: () => {
    const server: any = new EventEmitter();
    server.listen = (_port: number, _host: string, ready: () => void) => {
      deps.trace.push('port');
      if (deps.portBusy) server.emit('error', { code: 'EADDRINUSE' });
      else ready();
      return server;
    };
    server.close = (done: (error?: Error) => void) => done();
    return server;
  },
}));
import { installService, uninstallService } from '../scripts/service-control.mjs';

let base: string, root: string;
const record = (state: string) => ({
  Name: 'ihrmcp.exe', State: state, PathName: '"' + join(root, 'dist/daemon/ihrmcp.exe') + '"',
});
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'ihr-control-test-'));
  root = join(base, 'deployment');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist/index.js'), 'app');
  deps.current = null;
  deps.queryError = null;
  deps.portBusy = false;
  deps.trace.length = 0;
  deps.valid.mockReset();
  deps.wait.mockReset().mockImplementation(async (_root, accept) => {
    if (!accept(deps.current)) throw new Error('等待服务状态超时');
    return deps.current;
  });
  deps.exec.mockReset().mockImplementation((exe, args) => {
    deps.trace.push('exec:' + args[0]);
    if (exe === process.execPath) deps.current = record('Stopped');
    if (args[0] === 'start') deps.current = record('Running');
    if (args[0] === 'stop') deps.current = record('Stopped');
    if (args[0] === 'delete') deps.current = null;
    return '';
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true, json: async () => ({ configPath: join(root, 'config.json') }),
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (!resolve(base).startsWith(resolve(tmpdir()) + sep)) throw new Error('临时目录越界');
  rmSync(base, { recursive: true, force: true });
});

it('全新安装：先查询/检查端口，再注册和启动', async () => {
  await installService(root);
  expect(deps.current.State).toBe('Running');
  expect(deps.trace.indexOf('query')).toBeLessThan(deps.trace.indexOf('port'));
  expect(deps.trace.indexOf('port')).toBeLessThan(deps.trace.indexOf('exec:--input-type=module'));
  expect(deps.exec.mock.calls.some(([_exe, args]) => args.includes('taskkill'))).toBe(false);
});
it('无注册但有文件：隔离原 daemon 后安装', async () => {
  mkdirSync(join(root, 'dist/daemon'));
  writeFileSync(join(root, 'dist/daemon/ihrmcp.xml'), 'old');
  await installService(root);
  expect(existsSync(join(root, 'dist/daemon/ihrmcp.xml'))).toBe(false);
  expect(deps.current.State).toBe('Running');
});
it('已运行且健康：不注册、不停止、不探测占用端口', async () => {
  deps.current = record('Running');
  await installService(root);
  expect(deps.exec).not.toHaveBeenCalled();
  expect(deps.trace).not.toContain('port');
});
it('已有注册但守护损坏：安装报错，不覆盖注册', async () => {
  deps.current = record('Stopped');
  deps.valid.mockImplementation(() => { throw new Error('守护损坏'); });
  await expect(installService(root)).rejects.toThrow('守护损坏');
  expect(deps.exec).not.toHaveBeenCalled();
});
it('有注册无文件：卸载仍按真实 ID 删除', async () => {
  deps.current = record('Stopped');
  await uninstallService(root);
  expect(deps.exec.mock.calls.some(([_exe, args]) =>
    args[0] === 'delete' && args[1] === 'ihrmcp.exe')).toBe(true);
  expect(deps.current).toBeNull();
});
it('端口被占用：不强杀、不注册、不移动残留文件', async () => {
  mkdirSync(join(root, 'dist/daemon'));
  writeFileSync(join(root, 'dist/daemon/ihrmcp.xml'), 'keep');
  deps.portBusy = true;
  await expect(installService(root)).rejects.toThrow('端口不可用');
  expect(deps.exec).not.toHaveBeenCalled();
  expect(existsSync(join(root, 'dist/daemon/ihrmcp.xml'))).toBe(true);
});
it('注册命令返回成功但 SCM 仍为空：不能启动或报成功', async () => {
  deps.exec.mockReturnValue('');
  await expect(installService(root)).rejects.toThrow('超时');
  expect(deps.exec.mock.calls.some(([_exe, args]) => args[0] === 'start')).toBe(false);
});
it('注册命令失败：保留现场，不启动', async () => {
  deps.exec.mockImplementation(() => { throw Object.assign(new Error('failed'), { status: 1 }); });
  await expect(installService(root)).rejects.toThrow('注册命令失败');
});
it('删除尚未完成：超时后不移动 daemon', async () => {
  mkdirSync(join(root, 'dist/daemon'));
  writeFileSync(join(root, 'dist/daemon/ihrmcp.xml'), 'keep');
  deps.current = record('Stopped');
  deps.exec.mockReturnValue('');
  await expect(uninstallService(root)).rejects.toThrow('超时');
  expect(existsSync(join(root, 'dist/daemon/ihrmcp.xml'))).toBe(true);
});
it('DeleteService 返回 1072 时继续等待注册消失', async () => {
  deps.current = record('Stopped');
  deps.exec.mockImplementation((_exe, args) => {
    if (args[0] === 'delete') {
      deps.current = null;
      throw Object.assign(new Error('marked for deletion'), { status: 1072 });
    }
    return '';
  });
  await expect(uninstallService(root)).resolves.toBeUndefined();
  expect(deps.wait).toHaveBeenCalled();
});
it('删除权限错误不能当成删除待完成，也不移动守护', async () => {
  mkdirSync(join(root, 'dist/daemon'));
  writeFileSync(join(root, 'dist/daemon/ihrmcp.xml'), 'keep');
  deps.current = record('Stopped');
  deps.exec.mockImplementation(() => {
    throw Object.assign(new Error('Access denied'), { status: 5 });
  });
  await expect(uninstallService(root)).rejects.toThrow('Access denied');
  expect(deps.wait).not.toHaveBeenCalled();
  expect(existsSync(join(root, 'dist/daemon/ihrmcp.xml'))).toBe(true);
});
~~~

Run：rtk npm test -- test/service-control.test.ts。Expected：缺模块时失败；测试不得启动真实进程或绑定真实端口。

- [x] **Step 2: 实现端口检查、就绪验证及按 SCM 启停。**

scripts/service-control.mjs 的基础部分如下：

~~~javascript
import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, readFileSync, mkdtempSync, renameSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { serviceFor, assertDaemon, waitForService, normalizePath } from './service-state.mjs';

function address(root) {
  const path = join(root, 'config.json');
  let cfg = {};
  try { if (existsSync(path)) cfg = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error('config.json 读取或解析失败，请修正后再安装/启动'); }
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error('config.json 必须为配置对象');
  }
  const value = { port: cfg.port ?? 13210, host: cfg.host ?? '127.0.0.1' };
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535
      || typeof value.host !== 'string' || !value.host.trim()) {
    throw new Error('config.json 的 host/port 无效');
  }
  return value;
}

async function assertPortFree(root) {
  const { host, port } = address(root);
  await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', error => reject(new Error('端口不可用：' + port + '，' + error.code)));
    probe.listen(port, host, () => probe.close(error => error ? reject(error) : resolve()));
  });
}

function sc(action, name) {
  return execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'sc.exe'),
    [action, name], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
}

async function waitReady(root) {
  await waitForService(root, service => service?.State === 'Running');
  const { host, port } = address(root);
  const target = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  const url = 'http://' + (target.includes(':') ? '[' + target + ']' : target)
    + ':' + port + '/api/config';
  const deadline = Date.now() + 30000;
  do {
    const current = serviceFor(root);
    if (!current || current.State !== 'Running') throw new Error('服务启动后退出，请检查守护日志');
    try {
      const response = await fetch(url, {
        headers: { Host: 'localhost' }, signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        const body = await response.json();
        if (normalizePath(body.configPath) === normalizePath(join(root, 'config.json'))) return;
      }
    } catch { /* 仅重试就绪探测，SCM 查询错误不在此 catch 中 */ }
    if (Date.now() >= deadline) break;
    await delay(200);
  } while (Date.now() <= deadline);
  throw new Error('管理接口就绪超时或指向其他部署目录；服务未通过启动验收');
}

export async function startService(root) {
  const current = serviceFor(root);
  if (!current) throw new Error('服务未安装，请先执行 service-install.cmd');
  assertDaemon(root, current);
  if (current.State === 'Stopped') {
    await assertPortFree(root);
    sc('start', current.Name);
  } else if (current.State !== 'Running') {
    throw new Error('服务状态为 ' + current.State + '，请等待稳定后重试');
  }
  await waitReady(root);
}

export async function stopService(root) {
  const current = serviceFor(root);
  if (!current || current.State === 'Stopped') return;
  if (current.State !== 'Stop Pending') {
    try { sc('stop', current.Name); }
    catch (error) { if (error.status !== 1062) throw error; }
  }
  await waitForService(root, service => service === null || service.State === 'Stopped');
}
~~~

- [x] **Step 3: 实现孤立文件隔离、全新注册和不依赖文件的卸载。**

在同文件追加：

~~~javascript
function quarantineDaemon(root) {
  if (serviceFor(root)) throw new Error('服务注册仍存在，不能隔离守护文件');
  const source = resolve(root, 'dist', 'daemon');
  if (!existsSync(source)) return null;
  if (!lstatSync(source).isDirectory()
      || !normalizePath(source).startsWith(normalizePath(root) + '\\')) {
    throw new Error('守护目录类型或归属不正确');
  }
  const backup = mkdtempSync(join(dirname(resolve(root)), '.ihr-service-backup-'));
  const target = join(backup, 'daemon');
  // source 属于 root；target 属于新创建的同级备份目录，均在移动前验证。
  if (!normalizePath(target).startsWith(normalizePath(backup) + '\\')) {
    throw new Error('守护备份目标越界');
  }
  renameSync(source, target);
  console.log('[说明] 原守护已隔离到 ' + target);
  return target;
}

const registerSource = [
  "import windows from 'node-windows';",
  "import { join } from 'node:path';",
  "const root = process.env.IHR_SERVICE_ROOT;",
  "const service = new windows.Service({",
  "  name: 'ihr-mcp', description: 'ihr 考勤自动填报 MCP 服务端',",
  "  script: join(root, 'dist', 'index.js'), scriptOptions: '-t http',",
  "  workingDirectory: root",
  "});",
  "service.on('error', () => { process.exitCode = 1; });",
  "service.on('alreadyinstalled', () => { process.exitCode = 1; });",
  "service.install();",
].join('\n');

export async function installService(root) {
  root = resolve(root);
  const current = serviceFor(root); // 所有端口、文件、注册副作用之前
  if (current) {
    await startService(root); // 守护损坏时给出卸载重装指引
    return;
  }
  if (!existsSync(join(root, 'dist', 'index.js'))) throw new Error('请先构建或重新解压完整发布包');
  await assertPortFree(root);
  quarantineDaemon(root);
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', registerSource], {
      cwd: root, env: { ...process.env, IHR_SERVICE_ROOT: root },
      encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
    });
  } catch {
    const after = serviceFor(root);
    throw new Error('注册命令失败或超时；SCM '
      + (after ? '已存在注册' : '未发现注册') + '，保留现场，请复核后重试');
  }
  await waitForService(root, service => service !== null);
  await startService(root);
}

export async function uninstallService(root) {
  root = resolve(root);
  await stopService(root); // 不读取 daemon，文件丢失也能走 SCM
  const current = serviceFor(root);
  if (current) {
    try { sc('delete', current.Name); }
    catch (error) { if (error.status !== 1072) throw error; }
  }
  await waitForService(root, service => service === null);
  quarantineDaemon(root); // 只有确认注册消失后才能移动
}

export async function manageService(root, action) {
  switch (action) {
    case 'install': await installService(root); break;
    case 'uninstall': await uninstallService(root); break;
    case 'start': await startService(root); break;
    case 'stop': await stopService(root); break;
    case 'restart': await stopService(root); await startService(root); break;
    case 'status': {
      const current = serviceFor(root);
      console.log(current
        ? current.Name + '：' + current.State + '；' + current.PathName
        : '当前部署未安装服务');
      return;
    }
    default: throw new Error('操作必须为 install/uninstall/start/stop/restart/status');
  }
  console.log('[完成] ' + action + ' 已通过状态验证');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  manageService(root, (process.argv[2] || '').toLowerCase()).catch(error => {
    console.error('[错误] ' + error.message);
    process.exitCode = 1;
  });
}
~~~

删除命令遇到 marked for deletion 时等待真实消失；超时提示关闭占用服务句柄的管理窗口后复核，不自动重复创建。端口探测存在关闭探测 socket 到真实启动的竞态，后续 SCM 与 configPath 就绪验证用于发现启动未完成；绝不通过杀 PID 强行抢占端口。

- [x] **Step 4: 更新两个 Node 薄入口。**

scripts/service-install.mjs：

~~~javascript
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installService } from './service-control.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
installService(root).then(() => {
  console.log('[完成] 服务已安装并通过启动验证');
}).catch(error => {
  console.error('[错误] ' + error.message);
  process.exitCode = 1;
});
~~~

scripts/service-uninstall.mjs：

~~~javascript
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uninstallService } from './service-control.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
uninstallService(root).then(() => {
  console.log('[完成] 服务注册已清除，守护已隔离；程序文件与配置保留');
}).catch(error => {
  console.error('[错误] ' + error.message);
  process.exitCode = 1;
});
~~~

- [x] **Step 5: 更新 cmd 入口并保留退出码。**

保留安装/卸载的管理员自提升和交互暂停；提权父进程使用 Wait + PassThru 等待，并在独立标签中显式传回子进程退出码。不要在括号分支内使用无参数 exit /b：原生 CMD 替身已复现子进程失败码被外层报告为 0。以下为 service-install.cmd：

~~~bat
@echo off
chcp 65001 >nul
setlocal
title ihr-mcp 服务安装
net session >nul 2>&1
if errorlevel 1 goto elevate
cd /d "%~dp0"
node scripts\service-install.mjs
set "IHR_TASK_EXIT=%errorlevel%"
echo.
pause
exit /b %IHR_TASK_EXIT%
:elevate
set "IHR_ELEVATE_SCRIPT=%~f0"
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $p=Start-Process -FilePath $env:IHR_ELEVATE_SCRIPT -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
exit /b %errorlevel%
~~~

service-uninstall.cmd：

~~~bat
@echo off
chcp 65001 >nul
setlocal
title ihr-mcp 服务卸载
net session >nul 2>&1
if errorlevel 1 goto elevate
cd /d "%~dp0"
node scripts\service-uninstall.mjs
set "IHR_TASK_EXIT=%errorlevel%"
echo.
pause
exit /b %IHR_TASK_EXIT%
:elevate
set "IHR_ELEVATE_SCRIPT=%~f0"
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $p=Start-Process -FilePath $env:IHR_ELEVATE_SCRIPT -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
exit /b %errorlevel%
~~~

ihr-service.cmd：

~~~bat
@echo off
chcp 65001 >nul
setlocal
set "IHR_SERVICE_ACTION=%~1"
if /i "%IHR_SERVICE_ACTION%"=="status" goto run
if /i "%IHR_SERVICE_ACTION%"=="start" goto admin
if /i "%IHR_SERVICE_ACTION%"=="stop" goto admin
if /i "%IHR_SERVICE_ACTION%"=="restart" goto admin
echo 用法: ihr-service.cmd [start^|stop^|restart^|status]
exit /b 1
:admin
net session >nul 2>&1
if errorlevel 1 goto elevate
:run
cd /d "%~dp0"
node scripts\service-control.mjs "%IHR_SERVICE_ACTION%"
exit /b %errorlevel%
:elevate
set "IHR_ELEVATE_SCRIPT=%~f0"
powershell -NoProfile -Command "$ErrorActionPreference='Stop'; $p=Start-Process -FilePath $env:IHR_ELEVATE_SCRIPT -ArgumentList $env:IHR_SERVICE_ACTION -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
exit /b %errorlevel%
~~~

不再使用“先 net start 显示名再尝试历史名”的双调用，也不再由 status 查询错误的单一名称。三条自提升命令已使用 ErrorActionPreference=Stop；提权取消、启动失败或子进程失败均不得按成功返回。

- [x] **Step 6: 定向验证，补做注册冲突与就绪失败用例。**

在 test/service-control.test.ts 追加以下测试；它们使用已有 fixture：

~~~typescript
it('前置查询失败或注册归属冲突：不产生外部命令', async () => {
  for (const message of ['SCM 查询失败', '服务注册与目标部署目录冲突']) {
    deps.queryError = new Error(message);
    await expect(installService(root)).rejects.toThrow(message);
    await expect(uninstallService(root)).rejects.toThrow(message);
    expect(deps.exec).not.toHaveBeenCalled();
  }
});
it('删除后的查询失败必须报告失败，不能隔离文件', async () => {
  mkdirSync(join(root, 'dist/daemon'));
  writeFileSync(join(root, 'dist/daemon/ihrmcp.xml'), 'keep');
  deps.current = record('Stopped');
  deps.wait.mockRejectedValue(new Error('query failed'));
  await expect(uninstallService(root)).rejects.toThrow('query failed');
  expect(deps.exec.mock.calls.filter(([_exe, args]) => args[0] === 'delete')).toHaveLength(1);
  expect(existsSync(join(root, 'dist/daemon/ihrmcp.xml'))).toBe(true);
});
it('卸载无注册无文件时幂等成功', async () => {
  await uninstallService(root);
  expect(deps.exec).not.toHaveBeenCalled();
});
it('启动后立即退出不能报告完成', async () => {
  deps.current = record('Running');
  deps.wait.mockImplementation(async () => {
    deps.current = record('Stopped');
    return record('Running');
  });
  await expect(installService(root)).rejects.toThrow('启动后退出');
});
it('配置解析错误不能输出配置片段或执行系统命令', async () => {
  writeFileSync(join(root, 'config.json'), '{"password":"do-not-print",BROKEN');
  try {
    await installService(root);
    throw new Error('预期配置校验失败');
  } catch (error: any) {
    expect(error.message).toContain('config.json 读取或解析失败');
    expect(error.message).not.toContain('do-not-print');
  }
  expect(deps.exec).not.toHaveBeenCalled();
});

// 用原生 CMD 验证控制流，但把 net/node/PowerShell 全部替换为固定返回码。
// 不会调用 UAC、SCM、项目入口或真实进程终止命令。
async function runCmdFixture(file: string, action: string, elevate: boolean, code: number) {
  const { spawnSync } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  let text = readFileSync(new URL('../' + file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  text = text.replace(/^net session >nul 2>&1$/m, 'cmd /d /c exit ' + (elevate ? 1 : 0))
    .replace(/^node scripts.*$/gm, 'cmd /d /c exit ' + code)
    .replace(/^\s*powershell -NoProfile.*$/gm, 'cmd /d /c exit ' + code)
    .replace(/^pause$/gm, 'rem fixture pause disabled');
  if (/net session|node scripts|powershell -NoProfile/i.test(text)) {
    throw new Error('CMD fixture 中仍有未替换的系统调用');
  }
  const folder = join(base, 'cmd with spaces');
  mkdirSync(folder, { recursive: true });
  const fixture = join(folder, file);
  writeFileSync(fixture, text.replace(/\n/g, '\r\n'), 'utf8');
  const quote = String.fromCharCode(34);
  return spawnSync(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
    ['/d', '/s', '/c', quote + quote + fixture + quote + ' ' + action + quote],
    { encoding: 'utf8', windowsVerbatimArguments: true, windowsHide: true, timeout: 5000 });
}

const cmdCases = [
  { file: 'publish.cmd', action: '', elevates: false },
  { file: 'service-install.cmd', action: '', elevates: true },
  { file: 'service-uninstall.cmd', action: '', elevates: true },
  ...['start', 'stop', 'restart', 'status'].map(action => ({
    file: 'ihr-service.cmd', action, elevates: action !== 'status',
  })),
];
for (const entry of cmdCases) {
  for (const elevate of entry.elevates ? [false, true] : [false]) {
    for (const code of [0, 7]) {
      it.skipIf(process.platform !== 'win32')(
        entry.file + ' ' + entry.action + ' 提权=' + elevate + ' 返回码=' + code,
        async () => {
          const result = await runCmdFixture(entry.file, entry.action, elevate, code);
          expect(result.status).toBe(code);
          expect(result.stderr).toBe('');
        },
      );
    }
  }
}
it.skipIf(process.platform !== 'win32')('CMD 非法动作返回非零', async () => {
  const result = await runCmdFixture('ihr-service.cmd', 'invalid-action', false, 0);
  expect(result.status).toBe(1);
});
~~~

~~~powershell
rtk proxy node --check scripts/service-control.mjs
rtk proxy node --check scripts/service-install.mjs
rtk proxy node --check scripts/service-uninstall.mjs
rtk npm test -- test/service-control.test.ts test/service-state.test.ts
rtk npm run build
rtk npm test
~~~

Expected：无 taskkill 调用；无注册有文件可安装；有注册无文件可卸载；命令/查询/启动失败及超时不能输出成功。mjs 检查不可被 tsc 成功替代。原生 CMD 替身验证普通及提权分支正确透传返回码；真实 UAC 和服务结果仍在 Task 5 管理员验收中验证。

**检查点记录（2026-09-28）：** Task 4 完成；定向测试（含 SCM/服务替身与原生 CMD fixture）59 项通过，构建通过，全量测试 140 项通过。代码审查确认查询失败会阻止副作用，端口冲突不隔离文件，1072 仍等待 SCM 注册消失。未调用真实服务或 UAC；Task 5 仍需独立授权的现场验收，本机代码验证已完成。

---

### Task 5: 文档同步、完整验证与现场验收

**Files:** Modify README.md、doc/20260928-publish-exclude-daemon.md；验收后在 doc/bug-diagnosis-service-reinstall-broken-20260928.md 追加实施结果。本计划的任务框和验收记录同步更新。

**Interfaces:**
- Consumes：Tasks 1–4 的实际实现和测试输出。
- Produces：编译/测试/真实服务验收记录，以及与实际行为一致的用户操作说明。没有真实服务验收时不得写“全部已修复”。

- [x] **Step 1: 替换 README 的发布说明与端口冲突说明。**

发布说明替换为：

~~~markdown
发布目录可就地部署。对同一个版本目录重新打包前，先运行该目录的
ihr-service.cmd stop 并确认实际服务已停止，再执行 publish.cmd。
打包程序核对服务注册路径与守护配置，将 config.json、mapping.json 和有效的
dist/daemon 守护文件备份到发布目录同级的 .ihr-deploy-backup-* 目录。
纯净 ZIP 校验完成后还原这些文件；ZIP 不包含本机配置或守护。
只有打包成功后才运行 ihr-service.cmd start。失败时保持停服，按输出的备份位置
恢复配置与守护，并先确认应用文件完整；本流程不提供整个应用的自动回滚。

若发现孤立或损坏的守护，先核对目标部署目录，再执行
service-uninstall.cmd → service-install.cmd 恢复，不能直接忽略错误继续打包。
卸载会在确认注册消失后将守护移到 .ihr-service-backup-* 目录，保留程序与配置。
备份可能含本机配置，只在本机保留，确认无需恢复后再清理，不随发布包分发。

版本号改变会生成另一个目录，旧服务继续指向旧目录，配置与服务不会自动迁移。
建议从长期固定的目录安装服务；需要迁移时明确处理旧部署后再安装新部署。
~~~

“端口被占用”一行改为：

~~~markdown
| 端口被占用 | 安装/启动会报告冲突，不会强杀 PID。核实占用者后有序停止目标实例，或修改配置端口；不要结束无关进程。 |
~~~

同时补充下面的失败恢复操作。npm/复制失败可能使 stage 内的 cmd、scripts 或 node_modules 不完整，因此不能依赖损坏部署目录的脚本救援；从**完整的打包仓库根目录**调用共用模块，并使用报错给出的备份目录。下列操作限同一版本目录，需在停止服务后执行；版本目录改变时转入明确的迁移流程。

~~~powershell
$env:IHR_RECOVER_STAGE = Read-Host '输入失败发布的 stage 绝对路径'
$env:IHR_RECOVER_BACKUP = Read-Host '输入本次报错输出的 .ihr-deploy-backup-* 绝对路径'
node --input-type=module -e "import {readFileSync} from 'node:fs'; import {join} from 'node:path'; import {serviceFor,normalizePath} from './scripts/service-state.mjs'; import {restoreBackup} from './scripts/publish-preserve.mjs'; const root=process.env.IHR_RECOVER_STAGE; const expected=join(process.cwd(),'publish','ihr-mcp-v'+JSON.parse(readFileSync('package.json','utf8')).version); if(normalizePath(root)!==normalizePath(expected)) throw new Error('目标不是本仓库当前版本的 stage，请按迁移流程处理'); const svc=serviceFor(root); if(svc && svc.State!=='Stopped') throw new Error('先停止关联服务'); restoreBackup(root,process.env.IHR_RECOVER_BACKUP);"
if ($LASTEXITCODE -ne 0) { throw '备份还原失败，保持停服并保留现场' }
node --input-type=module -e "import {uninstallService} from './scripts/service-control.mjs'; await uninstallService(process.env.IHR_RECOVER_STAGE);"
if ($LASTEXITCODE -ne 0) { throw '残留服务处理失败，保留现场' }
node scripts/publish.mjs
if ($LASTEXITCODE -ne 0) { throw '重新构建仍失败，保持停服并保留新旧备份' }
node --input-type=module -e "import {installService} from './scripts/service-control.mjs'; await installService(process.env.IHR_RECOVER_STAGE);"
if ($LASTEXITCODE -ne 0) { throw '服务未通过恢复验收，请检查状态与日志' }
~~~

这条恢复链使用仓库中仍完整的控制脚本，重新生成应用目录，并保留配置；不是整个应用的自动回滚。不自动选“最新备份”，以免恢复到错误部署或错误时间点。

- [x] **Step 2: 同步 daemon 排除文档，保留诊断 review 证据。**

在 doc/20260928-publish-exclude-daemon.md 中更新原“目标”“不改的部分”“验证方式”：

~~~markdown
仓库 dist/daemon 不进入发布内容，防止打包机路径污染目标机器。
该排除本身不会保留已部署目录的守护；保留和恢复由
doc/20260928-publish-preserve-deemon.md 的方案 A+B 实现。

原先“打包完成后直接重启”的提示由停服前置检查、注册路径校验和失败恢复指引替代。
验证对象是生成的 ZIP，而非还原本机数据后的 stage：
ZIP 无 dist/daemon、config.json、mapping.json；成功后 stage 可包含经校验恢复的本机文件。
~~~

诊断报告不再按旧行号覆盖“立即解除”段落，也不重写历史 review 记录或把推断改为实证。完成验收后追加日期、提交/工作树版本、通过/未通过的场景和实际剩余限制。若未做真实验收，状态保持“代码修改完成，真实服务验收待完成”。

- [x] **Step 3: 执行全量门禁。**

~~~powershell
rtk proxy node --check scripts/service-state.mjs
rtk proxy node --check scripts/publish-preserve.mjs
rtk proxy node --check scripts/publish.mjs
rtk proxy node --check scripts/service-control.mjs
rtk proxy node --check scripts/service-install.mjs
rtk proxy node --check scripts/service-uninstall.mjs
rtk npm run build
rtk npm test
rtk git diff --check
~~~

每条命令读取真实退出码；上一步失败先修复再继续。新增未跟踪文件也要检查内容和行尾，git diff --check 不覆盖它们。不要因为某个示例写了“Expected PASS”便记录成实际通过。

**本地检查记录（2026-09-28）：** README、daemon 排除实施记录及诊断状态已同步；6 个 `.mjs` 检查、构建、全量 140 项测试及 `git diff --check` 均通过。CMD 文件已统一为 CRLF，新增源文件和文档检查未发现尾随空格。真实 ZIP 在隔离验收目录核验通过（4303 个条目）；真实服务主路径通过 Step 5、6 及 Step 7 端口冲突场景。UAC 批准分支通过，交互式取消分支未验证，故 Step 7 保持未完成。

- [x] **Step 4: 获得真实服务验收这一组操作的授权，再执行前置检查。**

本组会创建/启停/删除名为 ihrmcp.exe 的真实 Windows 服务，重建验收目录并运行 npm ci；授权针对整组动作，不逐步重复询问。使用管理员 PowerShell，代理通过 rtk proxy 承载下列 PowerShell 会话。

~~~powershell
$ErrorActionPreference = 'Stop'
$projectPath = (Get-Location).Path
$existingServices = @(Get-CimInstance Win32_Service | Where-Object {
  $_.Name -in @('ihrmcp.exe', 'ihr-mcp')
})
if ($existingServices.Count -gt 0) {
  throw '已有服务注册，不能占用其名称做验收；请使用隔离 Windows 环境或先明确处理已有部署'
}
$acceptRoot = Join-Path $projectPath 'publish\acceptance-20260928'
if (Test-Path -LiteralPath $acceptRoot) { throw '验收目录已存在，先核对现场，禁止直接覆盖' }
$acceptFull = [IO.Path]::GetFullPath($acceptRoot)
$workspacePrefix = [IO.Path]::GetFullPath($projectPath).TrimEnd('\') + '\'
if (-not $acceptFull.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw '验收目录越界'
}
New-Item -ItemType Directory -Path (Join-Path $acceptRoot 'dist') -Force | Out-Null
Get-ChildItem -LiteralPath (Join-Path $projectPath 'dist') |
  Where-Object Name -ne 'daemon' |
  Copy-Item -Destination (Join-Path $acceptRoot 'dist') -Recurse
foreach ($entry in @('scripts', 'skill', 'package.json', 'package-lock.json',
    'service-install.cmd', 'service-uninstall.cmd', 'ihr-service.cmd')) {
  Copy-Item -LiteralPath (Join-Path $projectPath $entry) -Destination $acceptRoot -Recurse
}
$env:IHR_ACCEPT_ROOT = $acceptRoot
node --input-type=module -e "import { publish } from './scripts/publish.mjs'; publish(process.env.IHR_ACCEPT_ROOT);"
if ($LASTEXITCODE -ne 0) { throw '初次验收打包失败' }
$version = (Get-Content -LiteralPath (Join-Path $acceptRoot 'package.json') -Raw | ConvertFrom-Json).version
$acceptStage = Join-Path $acceptRoot ('publish\ihr-mcp-v' + $version)
$env:IHR_ACCEPT_STAGE = $acceptStage
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $acceptStage 'config.json'),
  '{"host":"127.0.0.1","port":14210,"username":"","password":"","projectsRoot":"F:\\项目"}',
  $utf8NoBom)
[IO.File]::WriteAllText((Join-Path $acceptStage 'mapping.json'), '{"fixture":"fixture"}', $utf8NoBom)
~~~

验收端口固定 14210；已有占用时安装应中止，不自动腾出端口。这里复制并重新打包的是验收根目录，不重建用户当前的部署目录。配置只用 fixture 数据，管理接口可验证，不访问真实考勤账户。

- [x] **Step 5: 验证正常发布和运行中拒绝发布。**

~~~powershell
node (Join-Path $acceptStage 'scripts\service-control.mjs') install
if ($LASTEXITCODE -ne 0) { throw '安装/就绪验证失败' }
$beforeService = Get-CimInstance Win32_Service -Filter "Name='ihrmcp.exe'"
$expectedExe = Join-Path $acceptStage 'dist\daemon\ihrmcp.exe'
if ($beforeService.State -ne 'Running' -or $beforeService.PathName.Trim('"') -ne $expectedExe) {
  throw '服务状态或注册路径不符'
}
$preserveFiles = @('config.json', 'mapping.json', 'dist\daemon\ihrmcp.exe',
  'dist\daemon\ihrmcp.xml', 'dist\daemon\ihrmcp.exe.config')
$beforeHashes = @{}
foreach ($relative in $preserveFiles) {
  $beforeHashes[$relative] = (Get-FileHash -LiteralPath (Join-Path $acceptStage $relative)).Hash
}
node --input-type=module -e "import { publish } from './scripts/publish.mjs'; publish(process.env.IHR_ACCEPT_ROOT);"
if ($LASTEXITCODE -eq 0) { throw '运行中发布未被阻止' }
foreach ($relative in $preserveFiles) {
  if ((Get-FileHash -LiteralPath (Join-Path $acceptStage $relative)).Hash -ne $beforeHashes[$relative]) {
    throw ('拒绝发布后文件仍被改动：' + $relative)
  }
}
node (Join-Path $acceptStage 'scripts\service-control.mjs') stop
if ($LASTEXITCODE -ne 0) { throw '停服失败' }
node --input-type=module -e "import { publish } from './scripts/publish.mjs'; publish(process.env.IHR_ACCEPT_ROOT);"
if ($LASTEXITCODE -ne 0) { throw '停止状态下发布失败' }
foreach ($relative in $preserveFiles) {
  if ((Get-FileHash -LiteralPath (Join-Path $acceptStage $relative)).Hash -ne $beforeHashes[$relative]) {
    throw ('还原内容不一致：' + $relative)
  }
}
$afterService = Get-CimInstance Win32_Service -Filter "Name='ihrmcp.exe'"
if ($afterService.State -ne 'Stopped' -or $afterService.PathName -ne $beforeService.PathName) {
  throw '重打包改变了注册路径或自行启动服务'
}
node (Join-Path $acceptStage 'scripts\service-control.mjs') start
if ($LASTEXITCODE -ne 0) { throw '重打包后启动失败' }
node (Join-Path $acceptStage 'scripts\service-control.mjs') restart
if ($LASTEXITCODE -ne 0) { throw '重启失败' }
~~~

生产压缩代码已经对真实 ZIP 做条目校验，另将该 ZIP 的条目检查结果记入验收记录；不要以 stage 中还原后存在配置判定 ZIP 污染。

- [x] **Step 6: 验证“无注册有文件”和“有注册无文件”。**

以下命令仅在前一步记录的验收服务路径仍与 expectedExe 一致时执行；若不一致立即中止。不要替换为模糊名称删除。

~~~powershell
node (Join-Path $acceptStage 'scripts\service-control.mjs') stop
if ($LASTEXITCODE -ne 0) { throw '停服失败' }
$ownedService = Get-CimInstance Win32_Service -Filter "Name='ihrmcp.exe'"
if ($ownedService.State -ne 'Stopped' -or $ownedService.PathName.Trim('"') -ne $expectedExe) {
  throw '不能删除归属不符或未停止的服务'
}
sc.exe delete ihrmcp.exe
if ($LASTEXITCODE -ne 0) { throw '构造孤立守护状态失败' }
node --input-type=module -e "import { waitForService } from './scripts/service-state.mjs'; await waitForService(process.env.IHR_ACCEPT_STAGE, s => s === null);"
if ($LASTEXITCODE -ne 0) { throw '注册尚未消失' }
node (Join-Path $acceptStage 'scripts\service-control.mjs') install
if ($LASTEXITCODE -ne 0) { throw '无注册有文件的恢复失败' }

node (Join-Path $acceptStage 'scripts\service-control.mjs') stop
if ($LASTEXITCODE -ne 0) { throw '停服失败' }
$ownedService = Get-CimInstance Win32_Service -Filter "Name='ihrmcp.exe'"
if ($ownedService.State -ne 'Stopped' -or $ownedService.PathName.Trim('"') -ne $expectedExe) {
  throw '服务状态/归属已改变'
}
$missingSource = [IO.Path]::GetFullPath((Join-Path $acceptStage 'dist\daemon'))
$missingTarget = [IO.Path]::GetFullPath((Join-Path $acceptRoot 'missing-daemon-snapshot'))
if (-not $missingSource.StartsWith($acceptFull + '\', [StringComparison]::OrdinalIgnoreCase) -or
    -not $missingTarget.StartsWith($acceptFull + '\', [StringComparison]::OrdinalIgnoreCase) -or
    (Test-Path -LiteralPath $missingTarget)) { throw '守护快照移动目标不安全' }
Move-Item -LiteralPath $missingSource -Destination $missingTarget
node (Join-Path $acceptStage 'scripts\service-control.mjs') uninstall
if ($LASTEXITCODE -ne 0) { throw '有注册无文件的卸载失败' }
node (Join-Path $acceptStage 'scripts\service-control.mjs') install
if ($LASTEXITCODE -ne 0) { throw '恢复后全新安装失败' }
node (Join-Path $acceptStage 'scripts\service-control.mjs') uninstall
if ($LASTEXITCODE -ne 0) { throw '验收服务清理失败' }
~~~

Expected：第一次 install 隔离残留并重新生成；第二次 uninstall 即使 daemon 已移动也能清 SCM；最终回到“无注册”基线。保留验收目录和备份以供核查，不自动清理用户其他目录。

- [ ] **Step 7: 验证端口冲突与 cmd 退出码。**

~~~powershell
$listener = New-Object System.Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 14210)
$listener.Start()
try {
  node (Join-Path $acceptStage 'scripts\service-control.mjs') install
  if ($LASTEXITCODE -eq 0) { throw '端口占用时错误地安装成功' }
  if (-not $listener.Server.IsBound) { throw '占用端口的原实例被干扰' }
  if (@(Get-CimInstance Win32_Service -Filter "Name='ihrmcp.exe'").Count -ne 0) {
    throw '端口检查失败后仍创建了注册'
  }
} finally {
  $listener.Stop()
}
~~~

**Step 7 执行记录（部分完成，2026-09-28）：** 隔离 stage 的真实服务端口冲突返回非零，监听 socket 保持绑定且没有创建注册；在隔离验收根临时缺少 `dist/index.js` 时运行 `publish.cmd`，实际退出码为 1；全量 CMD fixture 的普通/提权分支退出码测试通过。完整 stage 的 `service-install.cmd` UAC 批准分支返回 0，之后服务已按 PathName 清理。交互式 UAC 取消分支未能确认：尝试期间实际出现了批准安装，不能按取消通过记录，因此本 Step 保持未完成。

在有用户交互的普通权限终端分别验证安装 cmd 的 UAC 取消和正确执行：取消返回非零，正确执行返回与 Node 一致的结果；管理员终端验证 publish.cmd 失败时暂停后仍返回非零。测试前后检查验收服务归属并卸载本次创建的服务。不用自动点击 UAC，也不把弹出窗口或控制台文字当作操作成功。

- [x] **Step 8: 记录结果，人工授权后提交。**

记录实际执行的命令、退出码、通过/未通过场景、备份位置和服务最终状态。不保留配置内容或账户凭据。诊断中的历史事件归因不因本次验收通过而自动变成实证。

提交前逐项检查 diff，特别区分 scripts/publish.mjs 原有排除改动和本次新增保护改动。只在用户明确授权提交后执行：

~~~powershell
rtk git add scripts/service-state.mjs scripts/publish-preserve.mjs scripts/service-control.mjs
rtk git add scripts/publish.mjs scripts/service-install.mjs scripts/service-uninstall.mjs
rtk git add publish.cmd service-install.cmd service-uninstall.cmd ihr-service.cmd
rtk git add test/service-state.test.ts test/publish-preserve.test.ts test/publish.test.ts test/service-control.test.ts
rtk git add README.md doc/20260928-publish-exclude-daemon.md doc/20260928-publish-preserve-deemon.md doc/bug-diagnosis-service-reinstall-broken-20260928.md
rtk git diff --cached --check
rtk git commit -m "fix: 保护就地部署文件并修复 Windows 服务安装卸载状态判断"
~~~

## 需求覆盖与验收判定

| 诊断要求 | 实施位置 | 证明方式 |
|---|---|---|
| 发布删除有效 daemon | Task 2 + Task 3 | 停止状态重打包后注册路径不变，三个文件 hash 不变 |
| 无注册有文件阻止安装 | Task 4 | 隔离旧文件后注册、启动、configPath 验证；真实 Step 6 |
| 有注册无文件无法卸载 | Task 4 | SCM stop/delete，不依赖 XML/exe；真实 Step 6 |
| install 回调假成功 | Task 4 | 子进程结果 + SCM + 就绪检查；注册未出现/失败/超时用例 |
| 服务 ID 与显示名混用 | Task 1 + Task 4 | 真实 Name、完整 PathName 判断，status 与启停同源 |
| 自检顺序与失败丢配置 | Task 2 + Task 3 | ZIP 检查先于还原；npm/zip/自检失败注入 |
| mapping 独立存在 | Task 2 | 没有 config 时 mapping 仍按字节还原 |
| 停服前置与目录归属 | Task 1–3 | Running/Pending/冲突/查询异常均不删除；真实 Step 5 |
| 安装前按端口杀进程 | Task 4 | 移除 taskkill；冲突不注册、不移动文件；真实 Step 7 |
| XML 错路径/守护不完整 | Task 1 + Task 4 | 校验 ID、--file、wrapper、工作目录和运行时文件；不盲目保留 |
| 失败与超时可观察 | Task 3 + Task 4 | 抛错、非零退出、cmd 透传；超时保留现场 |
| 新版本目录/其他部署 | Task 1 | 发布可生成独立新目录；安装/卸载拒绝其他目录注册；不自动迁移 |
| 强杀/断电 | 明确边界 | 不承诺自动恢复，磁盘备份及 manifest 可供人工恢复 |
| 历史根因证据缺口 | Task 5 | 保留诊断待验证项，不用模拟结果替代历史证据 |

## 计划自检与实施交接

- 所有任务引用的导出接口均在前序代码块定义；PowerShell 查询失败不得吞掉，默认严格归属只在发布场景显式放宽。
- 所有构建退出由异常穿过还原区间后交给顶层设置退出码；不使用 exit 钩子的“已开始还原即算完成”标志。
- 备份只对配置和守护提供可恢复副本，不声称完整应用事务回滚。
- 阶段性代码检查、定向测试和真实 Windows 验收分别记录，未执行的保持未勾选。
- 当前文档修订不意味着开始实施；本计划确认后，可选择按任务委派子 agent 或在当前会话逐项执行。提交仍须单独授权。

### 初版计划修订的验证记录（本轮复审前，尚非项目实施验收）

- 将文档代码块组合到独立临时目录，复用已安装的 Vitest 3.2.7；4 个测试文件、44 个替身测试通过。没有向项目 scripts/test 写入实施代码。
- 6 个 mjs 示例通过语法检查；13 个 PowerShell 片段通过解析器检查。验证环境为 Windows / Node.js 22.17.0。
- 只读执行结构化 SCM 查询和现存部署 XML 校验，通过；据实际系统服务存在空 PathName 的情况，增加“无关记录跳过、关联记录拒绝”的测试和处理。
- 在临时 fixture 上实际生成 ZIP：纯净包通过，加入 fixture config.json 后被拒绝；未压缩或重建用户部署目录。
- 本次未安装、卸载、启停服务，未终止进程，未执行项目代码编译或真实服务端到端验收。Tasks 1–5 的实施复选框仍保持未勾选。

参考资料：
- [Win32_Service 的 Name / State / PathName](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-service)：用于结构化读取真实服务标识、状态与启动路径。
- [Node.js process.exit / exitCode](https://nodejs.org/api/process.html)：受保护流程使用异常退出与 exitCode，避免主动终止绕过清理。
- [Compress-Archive](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.archive/compress-archive?view=powershell-5.1)：通过 LiteralPath 传入明确文件列表。
- [DeleteService](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-deleteservice)：1072 表示已标记删除；需等待服务停止且句柄关闭。
- [Vitest 模块模拟](https://vitest.dev/guide/mocking/modules)：测试环境会转换并求值导入，不能依赖原生 ESM 的缺少导出错误来阻止顶层副作用。

## 本轮五次 review 记录（2026-09-28）

用户要求审查正确性、可执行性和修复覆盖，连续两轮通过即停止，最多 5 轮。各轮由同一审查者完成；发现问题后只修订本计划，没有实施项目代码。通过表示计划和示例具备可执行依据，不表示真实服务故障已修复。

| 轮次 | 结果 | 证据、发现与处理 |
|---|---|---|
| 1 | 未通过，已修订 | 在临时旧脚本副本中执行原 Task 3 红测，测试收集期间删除了 stage 哨兵和 daemon；新增先隔离导入副作用的 Step 0。另用失败回归确认 1072 被直接抛出、ZIP 校验失败留下最终名称坏包；补充 1060/1072 状态确认、等待处理及临时 ZIP 校验后发布。补齐部署脚本不完整时从完整仓库恢复的操作。路径大小写探针未复现问题，未将其列为缺陷。 |
| 2 | 通过 | 修订后的 55 个替身测试及 6 个 mjs 语法检查通过。结构变换后的临时旧脚本出现 5 个预期行为红测失败，导入哨兵保留，证明测试前置可安全执行。逐项核对 A/B、四类注册/文件状态、备份与恢复、错误及超时处理。 |
| 3 | 未通过，已修订 | 原生 CMD fixture 发现三个服务入口的提权分支在子进程返回 9 时对外返回 0；分支内回显 errorlevel=9，确认不是服务操作结果。改为独立 elevate 标签和显式返回码，增加 25 个原生 CMD 替身用例。同期 14 个 PowerShell 片段解析、只读 SCM/XML 校验及真实临时 ZIP 排除检查通过。 |
| 4 | 通过 | 4 个测试文件共 80 个测试通过，覆盖普通/提权分支、管理动作、成功/失败码以及原有 1060/1072、包发布顺序、配置恢复和目录归属。复核新增分支与全部任务的接口、前置条件和恢复流程，无新增阻断项。 |
| 5 | 通过 | 对第 4 轮相同正文再次完整复核，哈希一致。真实 Node CLI 的发布前置失败、非法管理动作分别返回 1，只读 status 返回 0；使用非提权 fixture 验证真实 PowerShell Start-Process + Wait + PassThru 将子进程返回码 7 传回。诊断需求、代码示例、测试和现场验收对应，无新增阻断项。 |

第 4、5 轮审查的正文 SHA-256（本节之前 UTF-8 文本去除末尾空白）：cbdbca2ad8fe5563b01f07025c0a5f55aded538dab8aabef2f5dd0f5fd70df81。

**停止结果：共 5 轮，第 4、5 轮连续通过，按用户条件停止。** 方案 A+B 在约定的同目录部署范围内覆盖已确认的发布破坏与安装/卸载误判机制；历史事件归因仍保留证据边界。

验证使用临时文件、命令/服务替身、原生命令解释器、只读 SCM 查询及临时 ZIP。没有安装、卸载、启停真实服务或终止业务进程；真实 UAC、完整项目构建和真实服务端到端验收仍按 Task 5 执行。初版 44 个测试记录仅是此前版本的历史记录，当前复审依据为上述 80 个测试及补充探针。所有实施复选框保持未勾选。
