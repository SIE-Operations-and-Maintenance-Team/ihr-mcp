import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkEntry } from '../../src/ihr/parser.js';

describe('parseWorkEntry', () => {
  it('标准格式：编号|名称/活动类型', () => {
    const e = parseWorkEntry('SD26040155|方正微QMS二期质保-华为云计算技术制造运营管理系统·实施质保项目2026/项目执行');
    expect(e).toEqual({
      projectCode: 'SD26040155',
      projectName: '方正微QMS二期质保-华为云计算技术制造运营管理系统·实施质保项目2026',
      activityType: '项目执行',
      raw: 'SD26040155|方正微QMS二期质保-华为云计算技术制造运营管理系统·实施质保项目2026/项目执行',
    });
  });
  it('无活动类型：编号|名称', () => {
    const e = parseWorkEntry('SD26040155|某项目');
    expect(e?.projectCode).toBe('SD26040155');
    expect(e?.projectName).toBe('某项目');
    expect(e?.activityType).toBe('');
  });
  it('名称中含斜杠时取最后一个斜杠后的内容为活动类型', () => {
    const e = parseWorkEntry('SD26040155|A/B项目/项目执行');
    expect(e?.projectName).toBe('A/B项目');
    expect(e?.activityType).toBe('项目执行');
  });
  it('非法格式返回 null', () => {
    expect(parseWorkEntry('随便一个没有分隔符的字符串')).toBeNull();
    expect(parseWorkEntry('|项目名')).toBeNull();
  });
  it('真实条目样例全部可解析（fixtures）', () => {
    // vitest 以 ESM 执行测试文件，无 __dirname，需用 import.meta.url 定位
    const fixturesPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'entries.json');
    const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));
    for (const raw of fixtures) {
      const e = parseWorkEntry(raw);
      expect(e, `无法解析: ${raw}`).not.toBeNull();
      expect(e!.projectCode.length).toBeGreaterThan(0);
    }
  });
});
