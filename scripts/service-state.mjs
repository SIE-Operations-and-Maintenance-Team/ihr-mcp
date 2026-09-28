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
