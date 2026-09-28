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
// （configOk 恒 false：本组用例只验证快速失败与状态查询，正向路径由 e2e 覆盖）
function makeDeps(): ToolDeps {
  const cfg: LoadConfigResult = {
    username: '在此填入ihr用户名',
    password: '在此填入ihr密码',
    port: 13210,
    host: '127.0.0.1',
    projectsRoot: 'F:\\项目',
    configOk: false,
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
