import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, writeConfigTemplate, ensureConfigTemplate, resolveServerAddress } from '../src/config.js';

function tmpPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), 'ihr-mcp-')), name);
}

describe('loadConfig', () => {
  it('文件不存在时返回默认值且 configOk=false', () => {
    const r = loadConfig(tmpPath('none.json'));
    expect(r.configOk).toBe(false);
    expect(r.username).toBe('');
    expect(r.port).toBe(3210);
    expect(r.host).toBe('127.0.0.1');
    expect(r.projectsRoot).toBe('F:\\项目');
  });
  it('配置了用户名密码时 configOk=true', () => {
    const p = tmpPath('ok.json');
    writeFileSync(p, JSON.stringify({ username: 'u', password: 'p' }), 'utf8');
    const r = loadConfig(p);
    expect(r.configOk).toBe(true);
    expect(r.username).toBe('u');
    expect(r.port).toBe(3210);
  });
  it('只配用户名时 configOk=false', () => {
    const p = tmpPath('half.json');
    writeFileSync(p, JSON.stringify({ username: 'u' }), 'utf8');
    expect(loadConfig(p).configOk).toBe(false);
  });
});

describe('writeConfigTemplate', () => {
  it('生成模板文件，未填真实凭据前 configOk=false', () => {
    const p = tmpPath('tpl.json');
    writeConfigTemplate(p);
    expect(loadConfig(p).configOk).toBe(false);
    expect(loadConfig(p).port).toBe(3210);
  });
});

describe('ensureConfigTemplate（启动时自动生成，用户指令：没有才生成）', () => {
  it('配置不存在时生成占位符模板并返回 true', () => {
    const p = tmpPath('auto.json');
    expect(existsSync(p)).toBe(false);
    expect(ensureConfigTemplate(p)).toBe(true);
    expect(existsSync(p)).toBe(true);
    expect(loadConfig(p).configOk).toBe(false); // 占位符 → 未配置
    expect(loadConfig(p).port).toBe(3210);
  });
  it('配置已存在时不覆盖并返回 false', () => {
    const p = tmpPath('keep.json');
    writeFileSync(p, JSON.stringify({ username: 'real', password: 'real' }), 'utf8');
    expect(ensureConfigTemplate(p)).toBe(false);
    expect(loadConfig(p)).toMatchObject({ username: 'real', configOk: true }); // 未被覆盖
  });
});

describe('resolveServerAddress（监听地址优先级：命令行 > config.json > 内置默认）', () => {
  const cfg = { port: 4000, host: '0.0.0.0' };
  it('命令行参数优先', () => {
    expect(resolveServerAddress(cfg, { port: '5000', host: '127.0.0.1' })).toEqual({ port: 5000, host: '127.0.0.1' });
  });
  it('无命令行参数时取 config.json 值', () => {
    expect(resolveServerAddress(cfg)).toEqual({ port: 4000, host: '0.0.0.0' });
  });
  it('config.json 也缺省时回落内置默认 3210/127.0.0.1', () => {
    expect(resolveServerAddress({ port: undefined as any, host: undefined as any })).toEqual({ port: 3210, host: '127.0.0.1' });
  });
  it('仅命令行给端口时 host 仍取 config.json', () => {
    expect(resolveServerAddress(cfg, { port: '5000' })).toEqual({ port: 5000, host: '0.0.0.0' });
  });
});
