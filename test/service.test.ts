import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { currentMonthRange, listProjectsWithMapping } from '../src/service.js';
import { MappingStore } from '../src/mapping.js';
import { IHR_LIST_ENTRIES_PATH, IHR_USER_INFO_PATH, IHR_STAFF_HEADER_PATH } from '../src/ihr/client.js';

afterEach(() => vi.useRealTimers());

// mock：按 path 路由并记录调用（HTTP 恒 200，业务错误走 errorCode，见逆向结果 §0）
function makeHttp(routes: Record<string, unknown>, calls: Array<{ path: string; body: any }> = []) {
  return axios.create({
    adapter: (async (config: any) => {
      const path = String(config.url);
      calls.push({ path, body: config.data ? JSON.parse(config.data) : undefined });
      const route = routes[path];
      if (route === undefined) throw new Error(`测试未配置路由: ${path}`);
      return { data: route, status: 200, statusText: 'OK', headers: {}, config };
    }) as any,
  });
}

describe('currentMonthRange', () => {
  it('普通月（30 天）：当月 1 日 ~ 月末', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T10:00:00'));
    expect(currentMonthRange()).toEqual({ start: '2026-09-01', finish: '2026-09-30' });
  });

  it('闰年 2 月：finish 为 02-29', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2028-02-10T10:00:00'));
    expect(currentMonthRange()).toEqual({ start: '2028-02-01', finish: '2028-02-29' });
  });

  it('31 天大月，月末当天调用也不越界', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-31T23:00:00'));
    expect(currentMonthRange()).toEqual({ start: '2026-01-01', finish: '2026-01-31' });
  });
});

describe('listProjectsWithMapping（回归：修复前发的是当前周区间）', () => {
  it('按当月区间请求条目', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T10:00:00')); // 修复前该周为 2026-09-14~2026-09-20
    const calls: Array<{ path: string; body: any }> = [];
    const http = makeHttp({
      [IHR_USER_INFO_PATH]: { errorCode: '0', data: { staffId: 27710, staffName: '<姓名>' } },
      [`${IHR_STAFF_HEADER_PATH}?staffId=27710`]: { errorCode: '0', data: { deptCode: '4042', deptName: '运维部' } },
      [IHR_LIST_ENTRIES_PATH]: { errorCode: '0', data: [] },
    }, calls);
    const deps = {
      cfg: { username: 'u', password: 'p', port: 13210, host: '127.0.0.1', projectsRoot: 'F:\\不存在的目录', configOk: true },
      session: { getAuthedHttp: async () => http },
      mapping: new MappingStore(join(mkdtempSync(join(tmpdir(), 'ihr-mcp-')), 'mapping.json')),
    } as any;
    await listProjectsWithMapping(deps);
    const post = calls.find((c) => c.path === IHR_LIST_ENTRIES_PATH);
    expect(post?.body).toEqual({ userId: '27710', start: '2026-09-01', finish: '2026-09-30' });
  });

  it('输出条目的项目期望起止时间（manual 命中与 guess/none 分支均覆盖）', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T10:00:00'));
    const http = makeHttp({
      [IHR_USER_INFO_PATH]: { errorCode: '0', data: { staffId: 27710, staffName: '<姓名>' } },
      [`${IHR_STAFF_HEADER_PATH}?staffId=27710`]: { errorCode: '0', data: { deptCode: '4042', deptName: '运维部' } },
      [IHR_LIST_ENTRIES_PATH]: { errorCode: '0', data: [
        { taskType: '项目任务', poId: '1', poCode: 'SD99', poName: '某项目', tsTaskId: '11', tsTaskName: '项目执行', startDate: '2026-09-08', endDate: '2026-10-31' },
        { taskType: '部门任务', poId: '4042', poCode: '4042', poName: '运维部', tsTaskId: '0', tsTaskName: '部门出勤', startDate: '1970-01-01', endDate: '9999-12-31' },
      ] },
    });
    const mapping = new MappingStore(join(mkdtempSync(join(tmpdir(), 'ihr-mcp-')), 'mapping.json'));
    mapping.set('SD99', '某客户'); // manual 映射命中
    const deps = {
      cfg: { username: 'u', password: 'p', port: 13210, host: '127.0.0.1', projectsRoot: 'F:\\不存在的目录', configOk: true },
      session: { getAuthedHttp: async () => http },
      mapping,
    } as any;
    const views = await listProjectsWithMapping(deps);
    expect(views[0]).toMatchObject({ projectCode: 'SD99', customer: '某客户', customerSource: 'manual', expectedStartDate: '2026-09-08', expectedEndDate: '2026-10-31' });
    expect(views[1]).toMatchObject({ projectCode: '4042', customer: '未匹配', customerSource: 'none', expectedStartDate: '1970-01-01', expectedEndDate: '9999-12-31' });
  });
});
