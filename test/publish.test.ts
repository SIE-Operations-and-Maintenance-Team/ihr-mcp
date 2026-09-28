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
