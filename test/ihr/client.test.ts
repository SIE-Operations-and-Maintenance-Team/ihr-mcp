import { describe, it, expect } from 'vitest';
import axios from 'axios';
import {
  IhrClient, IHR_LIST_ENTRIES_PATH, IHR_SUBMIT_PATH, IHR_USER_INFO_PATH, IHR_STAFF_HEADER_PATH, IHR_LOCATION_PATH, IHR_BASE_NAME_PATH,
} from '../../src/ihr/client.js';

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

const USER_INFO = { errorCode: '0', data: { staffId: 27710, staffName: '<姓名>' } };
const STAFF_HEADER = { errorCode: '0', data: { deptCode: '4042', deptName: '运维部' } };
// 条目源数据样例（逆向结果 §1 真实结构节选）
const SOURCES = {
  errorCode: '0',
  data: [
    { taskType: '项目任务', poId: '7878649', poCode: 'SD26040155', poName: '方正微QMS二期质保-华为云计算技术制造运营管理系统·实施质保项目2026', tsTaskId: '7878655', tsTaskName: '项目执行', startDate: '2026-04-01', endDate: '2027-03-31' },
    { taskType: '部门任务', poId: '4042', poCode: '4042', poName: '运维部', tsTaskId: '0', tsTaskName: '部门出勤', startDate: '1970-01-01', endDate: '9999-12-31' },
  ],
};
const LOCATION = { errorCode: '0', data: [{ pmsId: 'B0HBBO6AQX', area: '大良镇' }] };
// Base 地名称（逆向结果 §3.5 实测结构）
const BASE_NAME = { errorCode: '0', errorMsg: 'success', data: '顺德' };
const OK = { errorCode: '0', data: null };

describe('IhrClient.listEntries', () => {
  it('按周区间请求并映射为 WorkEntry', async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const http = makeHttp({
      [IHR_USER_INFO_PATH]: USER_INFO,
      [`${IHR_STAFF_HEADER_PATH}?staffId=27710`]: STAFF_HEADER,
      [IHR_LIST_ENTRIES_PATH]: SOURCES,
    }, calls);
    const entries = await new IhrClient(http).listEntries('2026-09-21', '2026-09-27');
    const post = calls.find((c) => c.path === IHR_LIST_ENTRIES_PATH);
    expect(post?.body).toEqual({ userId: '27710', start: '2026-09-21', finish: '2026-09-27' });
    expect(entries[0]).toMatchObject({
      projectCode: 'SD26040155',
      activityType: '项目执行',
      taskType: '项目任务',
      tsTaskId: '7878655',
      raw: 'SD26040155|方正微QMS二期质保-华为云计算技术制造运营管理系统·实施质保项目2026/项目执行',
    });
  });
});

describe('IhrClient.submitWorkHours', () => {
  const base = {
    [IHR_USER_INFO_PATH]: USER_INFO,
    [`${IHR_STAFF_HEADER_PATH}?staffId=27710`]: STAFF_HEADER,
    [IHR_LIST_ENTRIES_PATH]: SOURCES,
    [IHR_LOCATION_PATH]: LOCATION,
    [`${IHR_BASE_NAME_PATH}/27710`]: BASE_NAME,
    [IHR_SUBMIT_PATH]: OK,
  };

  it('同周多条目合并为一次批量提交，项目任务带默认交付类型与地点', async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const http = makeHttp(base, calls);
    const results = await new IhrClient(http).submitWorkHours([
      { date: '2026-09-22', projectCode: 'SD26040155', activityType: '项目执行', hours: 8, workContent: 'x' },
      { date: '2026-09-24', projectCode: 'SD26040155', activityType: '项目执行', hours: 8, workContent: 'y' },
    ]);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success)).toBe(true);
    const submits = calls.filter((c) => c.path === IHR_SUBMIT_PATH);
    expect(submits).toHaveLength(1);
    const body = submits[0].body;
    expect(body.timeSheetMainDTO).toMatchObject({ staffId: 27710, deptCode: 4042, sourceType: 'WEB', startDate: '2026-09-21', endDate: '2026-09-27' });
    expect(body.timeSheetDetailDTOList).toHaveLength(2);
    expect(body.timeSheetDetailDTOList[0]).toMatchObject({ poCode: 'SD26040155', date: '2026-09-22', hours: 8, type: '工时', tsDeliveryType: '项目地交付', areaId: 'B0HBBO6AQX', area: '大良镇' });
  });

  it('errorCode 非 0 时该周条目全部失败并带回 errorMsg', async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const http = makeHttp({ ...base, [IHR_SUBMIT_PATH]: { errorCode: '400', errorMsg: '工时明细信息不能为空' } }, calls);
    const results = await new IhrClient(http).submitWorkHours([
      { date: '2026-09-22', projectCode: 'SD26040155', activityType: '项目执行', hours: 8, workContent: 'x' },
      { date: '2026-09-24', projectCode: 'SD26040155', activityType: '项目执行', hours: 8, workContent: 'y' },
    ]);
    expect(results.every((r) => !r.success)).toBe(true);
    expect(results[0].message).toContain('工时明细信息不能为空');
  });

  it('部门任务不携带交付类型与 areaId，area 取 Base 地名称', async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const http = makeHttp(base, calls);
    const results = await new IhrClient(http).submitWorkHours([
      { date: '2026-09-22', projectCode: '4042', activityType: '部门出勤', hours: 8, workContent: '值班' },
    ]);
    expect(results[0].success).toBe(true);
    const submit = calls.find((c) => c.path === IHR_SUBMIT_PATH);
    const detail = submit!.body.timeSheetDetailDTOList[0];
    expect(detail.tsDeliveryType).toBeUndefined();
    expect(detail.areaId).toBeUndefined();
    expect(detail.area).toBe('顺德');
    expect(calls.some((c) => c.path === IHR_LOCATION_PATH)).toBe(false);
  });

  it('居家远程交付未提供 area 时缺省为居家且不携带 areaId', async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const http = makeHttp(base, calls);
    const results = await new IhrClient(http).submitWorkHours([
      { date: '2026-09-22', projectCode: 'SD26040155', activityType: '项目执行', hours: 8, workContent: 'w', tsDeliveryType: '居家远程交付' },
    ]);
    expect(results[0].success).toBe(true);
    const detail = calls.find((c) => c.path === IHR_SUBMIT_PATH)!.body.timeSheetDetailDTOList[0];
    expect(detail.tsDeliveryType).toBe('居家远程交付');
    expect(detail.area).toBe('居家');
    expect(detail.areaId).toBeUndefined();
  });

  it('公司远程交付缺显式 area 时该周失败并提示，不静默为空', async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const http = makeHttp(base, calls);
    const results = await new IhrClient(http).submitWorkHours([
      { date: '2026-09-22', projectCode: 'SD26040155', activityType: '项目执行', hours: 8, workContent: 'w', tsDeliveryType: '公司远程交付' },
    ]);
    expect(results[0].success).toBe(false);
    expect(results[0].message).toContain('公司远程交付');
    expect(results[0].message).toContain('显式提供 area');
    expect(calls.some((c) => c.path === IHR_SUBMIT_PATH)).toBe(false);
  });

  it('跨两周条目按周一~周日分组逐周提交', async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const http = makeHttp(base, calls);
    const results = await new IhrClient(http).submitWorkHours([
      { date: '2026-09-22', projectCode: 'SD26040155', activityType: '项目执行', hours: 8, workContent: 'x' },
      { date: '2026-09-29', projectCode: 'SD26040155', activityType: '项目执行', hours: 8, workContent: 'y' },
    ]);
    expect(results.every((r) => r.success)).toBe(true);
    const submits = calls.filter((c) => c.path === IHR_SUBMIT_PATH);
    expect(submits).toHaveLength(2);
    expect(submits[0].body.timeSheetMainDTO).toMatchObject({ startDate: '2026-09-21', endDate: '2026-09-27' });
    expect(submits[1].body.timeSheetMainDTO).toMatchObject({ startDate: '2026-09-28', endDate: '2026-10-04' });
    expect(submits[0].body.timeSheetDetailDTOList[0].date).toBe('2026-09-22');
    expect(submits[1].body.timeSheetDetailDTOList[0].date).toBe('2026-09-29');
  });

  it('SUBMIT 返回 errorCode 401 时穿透抛出（交由上层 withReauth 重登重试）', async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const http = makeHttp({ ...base, [IHR_SUBMIT_PATH]: { errorCode: '401', errorMsg: '系统未登录或认证已过期' } }, calls);
    await expect(
      new IhrClient(http).submitWorkHours([
        { date: '2026-09-22', projectCode: 'SD26040155', activityType: '项目执行', hours: 8, workContent: 'x' },
      ]),
    ).rejects.toThrow(/errorCode=401/);
  });

  it('已成功周记忆：同一 client 重复提交相同条目时跳过已提交周', async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const http = makeHttp(base, calls);
    const client = new IhrClient(http);
    const entries = [
      { date: '2026-09-22', projectCode: 'SD26040155', activityType: '项目执行', hours: 8, workContent: 'x' },
      { date: '2026-09-29', projectCode: 'SD26040155', activityType: '项目执行', hours: 8, workContent: 'y' },
    ];
    const first = await client.submitWorkHours(entries);
    expect(first.every((r) => r.success)).toBe(true);
    const second = await client.submitWorkHours(entries);
    expect(second.every((r) => r.success && r.message.includes('前次已提交'))).toBe(true);
    expect(calls.filter((c) => c.path === IHR_SUBMIT_PATH)).toHaveLength(2); // 第二次零新提交
  });

  it('其他项目的项目地交付缺显式 areaId/area 时该周失败并提示，不回退本条目地点', async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const http = makeHttp(base, calls);
    const results = await new IhrClient(http).submitWorkHours([
      { date: '2026-09-22', projectCode: 'SD26040155', activityType: '项目执行', hours: 8, workContent: 'w', tsDeliveryType: '其他项目的项目地交付' },
    ]);
    expect(results[0].success).toBe(false);
    expect(results[0].message).toContain('其他项目的项目地交付');
    expect(results[0].message).toContain('areaId');
    expect(results[0].message).toContain('otherPoCode');
    expect(calls.some((c) => c.path === IHR_SUBMIT_PATH)).toBe(false);
    expect(calls.some((c) => c.path === IHR_LOCATION_PATH)).toBe(false);
  });
});

describe('IhrClient 非工作日报工（type 透传，用户指令：周末是否填报由用户确认）', () => {
  const base = {
    [IHR_USER_INFO_PATH]: USER_INFO,
    [`${IHR_STAFF_HEADER_PATH}?staffId=27710`]: STAFF_HEADER,
    [IHR_LIST_ENTRIES_PATH]: SOURCES,
    [IHR_LOCATION_PATH]: LOCATION,
    [IHR_SUBMIT_PATH]: OK,
  };

  it('type=加班 透传到提交体（周末/非工作日报工）', async () => {
    const calls: Array<{ path: string; body: any }> = [];
    const http = makeHttp(base, calls);
    const results = await new IhrClient(http).submitWorkHours([
      { date: '2026-09-26', projectCode: 'SD26040155', activityType: '项目执行', hours: 4, workContent: '周末上线值守', type: '加班' },
    ]);
    expect(results[0].success).toBe(true);
    const submit = calls.find((c) => c.path === IHR_SUBMIT_PATH);
    expect(submit!.body.timeSheetDetailDTOList[0]).toMatchObject({ date: '2026-09-26', type: '加班', hours: 4 });
  });
});
