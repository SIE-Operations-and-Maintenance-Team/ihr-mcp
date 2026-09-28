import { afterEach, describe, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: calls.exec }));
import { assertDaemon, serviceFor, waitForService } from '../scripts/service-state.mjs';

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

it('守护完整且 XML 路径吻合才通过；错脚本或缺文件均拒绝', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { dirname, join, resolve, sep } = await import('node:path');
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
