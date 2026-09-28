import { EventEmitter } from 'node:events';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

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
