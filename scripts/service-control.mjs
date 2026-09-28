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
  'const root = process.env.IHR_SERVICE_ROOT;',
  'const service = new windows.Service({',
  "  name: 'ihr-mcp', description: 'ihr 考勤自动填报 MCP 服务端',",
  "  script: join(root, 'dist', 'index.js'), scriptOptions: '-t http',",
  '  workingDirectory: root',
  '});',
  "service.on('error', () => { process.exitCode = 1; });",
  "service.on('alreadyinstalled', () => { process.exitCode = 1; });",
  'service.install();',
].join('\n');

export async function installService(root) {
  root = resolve(root);
  const current = serviceFor(root);
  if (current) {
    await startService(root);
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
  await stopService(root);
  const current = serviceFor(root);
  if (current) {
    try { sc('delete', current.Name); }
    catch (error) { if (error.status !== 1072) throw error; }
  }
  await waitForService(root, service => service === null);
  quarantineDaemon(root);
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
