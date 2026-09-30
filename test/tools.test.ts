import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { withReauth, createMcpServer, ToolDeps } from '../src/tools.js';
import { SessionManager } from '../src/session.js';
import { IhrAuthExpiredError } from '../src/ihr/client.js';
import { MappingStore } from '../src/mapping.js';
import { PmsError, type ProjectSnapshot } from '../src/pms/client.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoadConfigResult } from '../src/config.js';

describe('withReauth', () => {
  it('errorCode=401 时 invalidate 并重登重试一次', async () => {
    const invalidated: string[] = [];
    const deps = { session: { invalidateIfToken: (token: string) => { invalidated.push(token); return true; } } } as any;
    let calls = 0;
    const result = await withReauth(deps, async () => {
      calls++;
      if (calls === 1) throw new IhrAuthExpiredError('ihr 接口失败 [errorCode=401]: 系统未登录或认证已过期', 'T1');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
    expect(invalidated).toEqual(['T1']);
  });
  it('旧 token 的 401 不会清理当前新会话', async () => {
    let currentToken = 'T2';
    const invalidated: string[] = [];
    const deps = {
      session: {
        invalidateIfToken: (token: string) => {
          invalidated.push(token);
          if (token !== currentToken) return false;
          currentToken = '';
          return true;
        },
      },
    } as any;
    let calls = 0;
    const result = await withReauth(deps, async () => {
      calls++;
      if (calls === 1) throw new IhrAuthExpiredError('ihr 接口失败 [errorCode=401]: 认证已过期', 'T1');
      return currentToken;
    });

    expect(result).toBe('T2');
    expect(calls).toBe(2);
    expect(invalidated).toEqual(['T1']);
    expect(currentToken).toBe('T2');
  });
  it('第二次 401 直接返回且错误序列化不包含 token', async () => {
    const secret = 'request-token-secret';
    const invalidated: string[] = [];
    const deps = { session: { invalidateIfToken: (token: string) => { invalidated.push(token); return true; } } } as any;
    let calls = 0;
    let finalError: unknown;
    try {
      await withReauth(deps, async () => {
        calls++;
        throw new IhrAuthExpiredError('ihr 接口失败 [errorCode=401]: 认证已过期', secret);
      });
    } catch (err) {
      finalError = err;
    }

    expect(finalError).toBeInstanceOf(IhrAuthExpiredError);
    expect(calls).toBe(2);
    expect(invalidated).toEqual([secret]);
    expect(JSON.stringify(finalError)).not.toContain(secret);
    expect(Object.keys(finalError as object)).not.toContain('requestToken');
  });
  it('其他错误原样抛出，不 invalidate', async () => {
    let invalidated = 0;
    const deps = { session: { invalidateIfToken: () => invalidated++ } } as any;
    await expect(
      withReauth(deps, async () => {
        throw new Error('条目未找到: X|Y');
      }),
    ).rejects.toThrow('条目未找到: X|Y');
    expect(invalidated).toBe(0);
  });
});

describe('list_managed_projects', () => {
  it('returns the shared snapshot without credential fields', async () => {
    const deps = makeDeps(true);
    const snapshot: ProjectSnapshot = {
      schemaVersion: 1,
      sourceAccount: 'test-user',
      fetchedAt: '2026-09-29T00:00:00Z',
      complete: true,
      projects: [],
    };
    deps.managedProjects = async () => snapshot;
    const result = await callTool(deps, 'list_managed_projects');
    const data = JSON.parse((result.content as any)[0].text);

    expect(data).toEqual(snapshot);
    expect(data).not.toHaveProperty('token');
    expect(data).not.toHaveProperty('password');
    expect(result.isError).not.toBe(true);
  });

  it('returns PmsError as a structured isError result', async () => {
    const deps = makeDeps(true);
    deps.managedProjects = async () => { throw new PmsError('AUTH_REQUIRED', '请先登录 PMS'); };
    const result = await callTool(deps, 'list_managed_projects');

    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as any)[0].text)).toEqual({
      error: { code: 'AUTH_REQUIRED', message: '请先登录 PMS' },
    });
  });

  it('reports an uninitialized PMS query without calling a live service', async () => {
    const deps = makeDeps(true);
    const result = await callTool(deps, 'list_managed_projects');

    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as any)[0].text)).toMatchObject({
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'PMS 查询未初始化' },
    });
  });
});

// InMemory 端到端脚手架：真实走 createMcpServer 处理器与 McpError 透传，无网络
// （默认 configOk=false 验证快速失败与状态查询；configOk=true 仅用于触发快速失败之后的校验分支，
//   这些分支在真正登录/联网之前就结束，不会发起真实请求）
function makeDeps(configOk = false): ToolDeps {
  const cfg: LoadConfigResult = {
    username: configOk ? 'u' : '在此填入ihr用户名',
    password: configOk ? 'p' : '在此填入ihr密码',
    port: 13210,
    host: '127.0.0.1',
    projectsRoot: 'F:\\项目',
    configOk,
  };
  return {
    cfg,
    session: new SessionManager(cfg),
    mapping: new MappingStore(join(mkdtempSync(join(tmpdir(), 'ihr-mcp-')), 'mapping.json')),
  };
}

async function callTool(deps: ToolDeps, name: string, args: Record<string, unknown> = {}) {
  const server = createMcpServer(deps);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

describe('失败报错携带配置路径（用户指令）', () => {
  it('get_login_status 返回 configPath（config.json 结尾）', async () => {
    const deps = makeDeps();
    const r = await callTool(deps, 'get_login_status');
    const payload = JSON.parse((r.content as any)[0].text);
    expect(payload.configPath).toMatch(/config\.json$/);
    expect(payload.configOk).toBe(false);
  });

  it('configOk=false 时 list_projects 快速失败并给出配置路径', async () => {
    const deps = makeDeps();
    await expect(callTool(deps, 'list_projects')).rejects.toThrow(
      /凭据未配置: 请填写 .+config\.json 的 username\/password 后重启服务/,
    );
  });

  it('configOk=false 时 fill_work_hours 同样快速失败（在参数校验之前）', async () => {
    const deps = makeDeps();
    await expect(
      callTool(deps, 'fill_work_hours', { entries: [{ date: 'bad' }] }),
    ).rejects.toThrow(/凭据未配置/);
  });
});

describe('get_config（skill 去路径化：动态取扫描根目录，凭据永不出 MCP）', () => {
  it('返回 projectsRoot，且不含任何凭据字段', async () => {
    const deps = makeDeps();
    const r = await callTool(deps, 'get_config');
    const payload = JSON.parse((r.content as any)[0].text);
    expect(payload.projectsRoot).toBe('F:\\项目');
    expect(payload).not.toHaveProperty('username');
    expect(payload).not.toHaveProperty('password');
    expect(Object.keys(payload)).toEqual(['projectsRoot']);
  });
});

describe('fill_work_hours type 校验（用户指令：周末填报走加班类型）', () => {
  it('type 不是 工时/加班 时参数校验失败，且在凭据检查之后、不触发登录', async () => {
    const deps = makeDeps(true);
    await expect(
      callTool(deps, 'fill_work_hours', {
        entries: [{ date: '2026-09-26', projectCode: 'SD26040155', activityType: '项目执行', hours: 4, workContent: 'x', type: '调休' }],
      }),
    ).rejects.toThrow('entries 参数不合法');
  });
});
