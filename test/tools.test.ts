import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { withReauth, createMcpServer, ToolDeps } from '../src/tools.js';
import { SessionManager } from '../src/session.js';
import { MappingStore } from '../src/mapping.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoadConfigResult } from '../src/config.js';

describe('withReauth', () => {
  it('errorCode=401 时 invalidate 并重登重试一次', async () => {
    let invalidated = 0;
    const deps = { session: { invalidate: () => invalidated++ } } as any;
    let calls = 0;
    const result = await withReauth(deps, async () => {
      calls++;
      if (calls === 1) throw new Error('ihr 接口失败 [errorCode=401]: 系统未登录或认证已过期');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
    expect(invalidated).toBe(1);
  });
  it('其他错误原样抛出，不 invalidate', async () => {
    let invalidated = 0;
    const deps = { session: { invalidate: () => invalidated++ } } as any;
    await expect(
      withReauth(deps, async () => {
        throw new Error('条目未找到: X|Y');
      }),
    ).rejects.toThrow('条目未找到: X|Y');
    expect(invalidated).toBe(0);
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
