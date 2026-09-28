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
    mkdirSync(join(stage, 'config.json'));
  })).toThrow('还原失败');
  expect(readFileSync(join(stage, 'mapping.json'), 'utf8')).toBe('map');
  const backup = join(base, readdirSync(base).find(name => name.startsWith('.ihr-deploy-backup-'))!);
  expect(existsSync(join(backup, 'manifest.json'))).toBe(true);
  rmSync(join(stage, 'config.json'), { recursive: true });
  restoreBackup(stage, backup);
  restoreBackup(stage, backup);
  expect(readFileSync(join(stage, 'config.json'), 'utf8')).toBe('cfg');
});
