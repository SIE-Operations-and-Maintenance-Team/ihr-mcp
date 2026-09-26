import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guessCustomer, MappingStore } from '../src/mapping.js';

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'ihr-mcp-')), 'mapping.json');
}

describe('guessCustomer', () => {
  const folders = ['方正微', '中恒MES', '华俊', '埃泰克'];
  it('项目名包含客户文件夹名时返回该客户', () => {
    expect(guessCustomer('方正微QMS二期质保-华为云计算技术制造运营管理系统·实施质保项目2026', folders)).toBe('方正微');
  });
  it('多个文件夹名都命中时取最长者', () => {
    expect(guessCustomer('中恒MES项目二期建设', ['中恒', '中恒MES'])).toBe('中恒MES');
  });
  it('无命中返回 null', () => {
    expect(guessCustomer('完全不相关的项目名', folders)).toBeNull();
  });
});

describe('MappingStore', () => {
  it('set 后 get 返回值，load 反映变更（持久化）', () => {
    const p = tmpFile();
    const store = new MappingStore(p);
    expect(store.get('SD26040155')).toBeUndefined();
    store.set('SD26040155', '方正微');
    expect(store.get('SD26040155')).toBe('方正微');
    expect(new MappingStore(p).load()).toEqual({ SD26040155: '方正微' });
  });
  it('文件不存在时 load 返回空对象', () => {
    expect(new MappingStore(tmpFile()).load()).toEqual({});
  });
});
