import axios from 'axios';
import { describe, expect, it, vi } from 'vitest';
import {
  parseProjectPage,
  PmsClient,
  PmsError,
  PMS_LIST_PATH,
  shanghaiDate,
  type ManagedProject,
  type ProjectPage,
} from '../src/pms/client.js';
import { collectProjects, listManagedProjects } from '../src/pms/service.js';
import { SessionLoginError, type SsoSnapshot } from '../src/session.js';

function project(projectId: string, projectCode: string): ManagedProject {
  return {
    projectId,
    projectCode,
    projectName: `项目 ${projectCode}`,
    status: '进行中',
    planStartDate: '2026-04-01',
    planEndDate: '2027-03-31',
  };
}

function page(currentPage: number, totalPages: number, projects: ManagedProject[]): ProjectPage {
  return { currentPage, totalPages, projects };
}

function fakeClient(listPage: (sso: SsoSnapshot, pageNo: number, signal: AbortSignal) => Promise<ProjectPage>): PmsClient {
  return { listPage } as unknown as PmsClient;
}

function successResponse(projects: unknown[], currentPage = 1, totalPages = 1) {
  return { code: 'success', data: projects, page: { currentPage, totalPages } };
}

function rawProject(id: unknown = 1, code: unknown = 'SD1', overrides: Record<string, unknown> = {}) {
  return {
    type: 'project',
    project: { id, code, name: '示例项目' },
    status: { name: '进行中' },
    planBeginTime: Date.parse('2026-03-31T16:00:00Z'),
    planEndTime: Date.parse('2027-03-30T16:00:00Z'),
    stage: { planEndTime: Date.parse('2030-01-01T00:00:00Z') },
    ...overrides,
  };
}

describe('PMS 日期转换', () => {
  it('按 UTC+8 日期转换计划时间戳，并保留 null', () => {
    expect(shanghaiDate(Date.parse('2027-01-29T17:00:00Z'))).toBe('2027-01-30');
    expect(shanghaiDate(null)).toBeNull();
  });

  it('拒绝非毫秒数字或越界时间', () => {
    expect(() => shanghaiDate('2027-01-30')).toThrowError(PmsError);
    expect(() => shanghaiDate(Number.MAX_VALUE)).toThrowError(PmsError);
  });
});

describe('PMS 项目响应解析', () => {
  it('逐字段解析项目并只使用顶层计划日期', () => {
    const parsed = parseProjectPage(successResponse([rawProject()]), 1);
    expect(parsed).toEqual({
      currentPage: 1,
      totalPages: 1,
      projects: [{
        projectId: '1',
        projectCode: 'SD1',
        projectName: '示例项目',
        status: '进行中',
        planStartDate: '2026-04-01',
        planEndDate: '2027-03-31',
      }],
    });
  });

  it('顶层计划日期缺失时返回 null，不回退阶段日期', () => {
    const parsed = parseProjectPage(successResponse([rawProject(1, 'SD1', { planEndTime: null })]), 1);
    expect(parsed.projects[0].planEndDate).toBeNull();
  });

  it('安全保留字符串 ID，并拒绝不安全数字 ID 和空编号', () => {
    expect(parseProjectPage(successResponse([rawProject('9007199254740993', 'SD1')]), 1).projects[0].projectId)
      .toBe('9007199254740993');
    expect(() => parseProjectPage(successResponse([rawProject(Number.MAX_SAFE_INTEGER + 1, 'SD1')]), 1))
      .toThrowError(PmsError);
    expect(() => parseProjectPage(successResponse([rawProject('  ', 'SD1')]), 1)).toThrowError(PmsError);
    expect(() => parseProjectPage(successResponse([rawProject(1, '  ')]), 1)).toThrowError(PmsError);
  });

  it('拒绝未知业务码、缺字段和错误页码', () => {
    expect(() => parseProjectPage({ code: 'E000099' }, 1)).toThrowError(PmsError);
    expect(() => parseProjectPage({ code: 'success', data: [] }, 1)).toThrowError(PmsError);
    expect(() => parseProjectPage(successResponse([], 2, 2), 1)).toThrowError(PmsError);
  });

  it('将任务 00 确认的无效凭据业务码分类为 AUTH_REQUIRED', () => {
    try {
      parseProjectPage({ code: 'E000001', data: null }, 1);
      throw new Error('expected PmsError');
    } catch (err) {
      expect(err).toBeInstanceOf(PmsError);
      expect((err as PmsError).code).toBe('AUTH_REQUIRED');
    }
  });
});

describe('PmsClient.listPage', () => {
  it('使用固定项目列表参数、仅携带 PMS Cookie 并遵守分页请求限制', async () => {
    const requests: any[] = [];
    const http = axios.create({
      adapter: (async (config: any) => {
        requests.push(config);
        return {
          data: successResponse([rawProject()]),
          status: 200,
          statusText: 'OK',
          headers: {},
          config,
        };
      }) as any,
    });
    const signal = new AbortController().signal;
    const result = await new PmsClient(http).listPage({ token: 'T1', generation: 1 }, 1, signal);

    expect(result.projects[0].projectCode).toBe('SD1');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(PMS_LIST_PATH);
    expect(JSON.parse(requests[0].data)).toEqual({
      attended: false,
      iAmProjectManager: true,
      recentVisit: false,
      orderBy: '',
      orderType: 'DESC',
      pageNo: 1,
      pageSize: 20,
      personOverview: true,
      processing: false,
      iAmManager: false,
    });
    expect(requests[0].headers.Cookie).toBe('token=T1');
    expect(requests[0].headers.Authorization).toBeUndefined();
    expect(requests[0].timeout).toBe(20_000);
    expect(requests[0].maxRedirects).toBe(0);
    expect(requests[0].signal).toBe(signal);
  });

  it('将网络错误映射为 UPSTREAM_UNAVAILABLE', async () => {
    const http = axios.create({
      adapter: (async () => { throw Object.assign(new Error('offline'), { code: 'ECONNRESET' }); }) as any,
    });
    await expect(new PmsClient(http).listPage({ token: 'T1', generation: 1 }, 1, new AbortController().signal))
      .rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });
});

describe('PMS 项目分页聚合', () => {
  it('按 totalPages 翻页并按项目 ID 去重', async () => {
    const firstProject = project('1', 'SD1');
    const seen: number[] = [];
    const rows = await collectProjects(async (pageNo) => {
      seen.push(pageNo);
      return {
        currentPage: pageNo,
        totalPages: 2,
        projects: pageNo === 1 ? [firstProject] : [firstProject, project('2', 'SD2')],
      };
    });

    expect(seen).toEqual([1, 2]);
    expect(rows.map((row) => row.projectId)).toEqual(['1', '2']);
  });

  it('允许真实空结果，并拒绝页数变化、非末页空页和无进展重复页', async () => {
    await expect(collectProjects(async () => page(1, 0, []))).resolves.toEqual([]);
    await expect(collectProjects(async (pageNo) => page(
      pageNo,
      pageNo === 1 ? 2 : 3,
      [project(String(pageNo), `SD${pageNo}`)],
    )))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(collectProjects(async (pageNo) => page(pageNo, 2, pageNo === 1 ? [] : [project('2', 'SD2')])))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(collectProjects(async () => page(1, 2, [project('1', 'SD1')])))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('拒绝 ID/项目编号冲突及超过 100 页的快照', async () => {
    await expect(collectProjects(async (pageNo) => page(pageNo, 2, pageNo === 1
      ? [project('1', 'SD1')]
      : [project('1', 'SD2')]))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(collectProjects(async () => page(1, 101, []))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

describe('listManagedProjects', () => {
  it('只在全量完成后返回快照，PMS 认证失败时从第一页重取', async () => {
    let current: SsoSnapshot = { token: 'T1', generation: 1 };
    const invalidated: number[] = [];
    const session = {
      getSsoSnapshot: async () => ({ ...current }),
      invalidateIfCurrent: (generation: number) => {
        invalidated.push(generation);
        if (generation !== current.generation) return false;
        current = { token: 'T2', generation: generation + 1 };
        return true;
      },
    };
    const calls: Array<{ token: string; pageNo: number }> = [];
    const client = fakeClient(async (sso, pageNo) => {
      calls.push({ token: sso.token, pageNo });
      if (sso.token === 'T1' && pageNo === 2) throw new PmsError('AUTH_REQUIRED', 'expired');
      if (sso.token === 'T1') return page(1, 2, [project('old', 'OLD')]);
      return page(pageNo, 2, pageNo === 1 ? [project('2', 'SD2')] : [project('3', 'SD3')]);
    });

    const snapshot = await listManagedProjects({
      session: session as any,
      sourceAccount: 'account',
      client,
    });

    expect(calls).toEqual([
      { token: 'T1', pageNo: 1 },
      { token: 'T1', pageNo: 2 },
      { token: 'T2', pageNo: 1 },
      { token: 'T2', pageNo: 2 },
    ]);
    expect(invalidated).toEqual([1]);
    expect(snapshot).toMatchObject({ schemaVersion: 1, sourceAccount: 'account', complete: true });
    expect(snapshot.projects.map((row) => row.projectCode)).toEqual(['SD2', 'SD3']);
    expect(JSON.stringify(snapshot)).not.toContain('T1');
    expect(JSON.stringify(snapshot)).not.toContain('T2');
    expect(Number.isNaN(Date.parse(snapshot.fetchedAt))).toBe(false);
  });

  it('二次认证失败退出，不返回不完整快照', async () => {
    const session = {
      getSsoSnapshot: async () => ({ token: 'T1', generation: 1 }),
      invalidateIfCurrent: () => true,
    };
    let calls = 0;
    const client = fakeClient(async () => {
      calls++;
      throw new PmsError('AUTH_REQUIRED', 'invalid credentials');
    });

    await expect(listManagedProjects({ session: session as any, sourceAccount: 'account', client }))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(calls).toBe(2);
  });

  it('第二页上游失败时不返回第一页的部分数据', async () => {
    const session = { getSsoSnapshot: async () => ({ token: 'T1', generation: 1 }) };
    const client = fakeClient(async (_sso, pageNo) => {
      if (pageNo === 1) return page(1, 2, [project('1', 'SD1')]);
      throw new PmsError('UPSTREAM_UNAVAILABLE', 'offline');
    });

    await expect(listManagedProjects({ session: session as any, sourceAccount: 'account', client }))
      .rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
  });

  it('把 SSO 网络、账号失效和未知错误分别分类', async () => {
    const cases: Array<[string, PmsError['code']]> = [
      ['NETWORK', 'UPSTREAM_UNAVAILABLE'],
      ['HTTP_503', 'UPSTREAM_UNAVAILABLE'],
      ['SESSION_CHANGED', 'UPSTREAM_UNAVAILABLE'],
      ['40001', 'AUTH_REQUIRED'],
      ['40009', 'AUTH_REQUIRED'],
      ['300008', 'INVALID_RESPONSE'],
    ];
    for (const [code, expected] of cases) {
      const session = { getSsoSnapshot: async () => { throw new SessionLoginError(code, 'login failed'); } };
      await expect(listManagedProjects({
        session: session as any,
        sourceAccount: 'account',
        client: fakeClient(async () => page(1, 1, [])),
      })).rejects.toMatchObject({ code: expected });
    }
  });

  it('整体截止时间涵盖等待共享 SSO 登录，超时不取消底层登录 Promise', async () => {
    vi.useFakeTimers();
    let resolveLogin: ((snapshot: SsoSnapshot) => void) | undefined;
    const session = {
      getSsoSnapshot: () => new Promise<SsoSnapshot>((resolve) => { resolveLogin = resolve; }),
    };
    try {
      const pending = listManagedProjects({
        session: session as any,
        sourceAccount: 'account',
        client: fakeClient(async () => page(1, 1, [])),
      });
      const timedOut = expect(pending).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
      await vi.advanceTimersByTimeAsync(120_000);
      await timedOut;
      expect(resolveLogin).toBeTypeOf('function');
    } finally {
      vi.useRealTimers();
    }
  });
});
