import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { expect, it } from 'vitest';
import { LoadConfigResult } from '../src/config.js';
import { MappingStore } from '../src/mapping.js';
import { PmsError, type ProjectSnapshot } from '../src/pms/client.js';
import { SessionManager } from '../src/session.js';
import { createMcpServer, ToolDeps } from '../src/tools.js';
import { createWebApi } from '../src/web/api.js';

const cfg: LoadConfigResult = {
  username: 'test-user',
  password: 'test-password',
  port: 13210,
  host: '127.0.0.1',
  projectsRoot: 'F:/example',
  configOk: true,
};

const snapshot: ProjectSnapshot = {
  schemaVersion: 1,
  sourceAccount: 'test-user',
  fetchedAt: '2026-09-29T00:00:00Z',
  complete: true,
  projects: [],
};

function makeDeps(managedProjects?: () => Promise<ProjectSnapshot>): ToolDeps {
  return {
    cfg,
    session: new SessionManager(cfg),
    mapping: new MappingStore(join(mkdtempSync(join(tmpdir(), 'pms-route-')), 'mapping.json')),
    managedProjects,
  };
}

async function withServer<T>(deps: ToolDeps, run: (port: number) => Promise<T>): Promise<T> {
  const server = http.createServer(createWebApi(deps));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  try {
    return await run(port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

async function callMcp(deps: ToolDeps): Promise<unknown> {
  const server = createMcpServer(deps);
  const client = new Client({ name: 'pms-web-test', version: '0.0.0' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: 'list_managed_projects', arguments: {} });
    return JSON.parse((result.content as any)[0].text);
  } finally {
    await client.close();
    await server.close();
  }
}

function requestWithHost(port: number, hostHeader: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/pms/managed-projects',
      method: 'GET',
      headers: { host: hostHeader },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

it('HTTP 与 MCP 返回相同的完整项目快照', async () => {
  const deps = makeDeps(async () => snapshot);
  const mcpData = await callMcp(deps);
  await withServer(deps, async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/pms/managed-projects`);
    expect(response.status).toBe(200);
    const httpData = await response.json();
    expect(httpData).toEqual(snapshot);
    expect(httpData).toEqual(mcpData);
  });
});

it('HTTP 将 PMS 错误映射为 401、503、502，且不暴露原始错误对象', async () => {
  let failure: unknown = new PmsError('AUTH_REQUIRED', '请先登录 PMS');
  const deps = makeDeps(async () => { throw failure; });
  await withServer(deps, async (port) => {
    const cases: Array<[PmsError, number]> = [
      [new PmsError('AUTH_REQUIRED', '请先登录 PMS'), 401],
      [new PmsError('UPSTREAM_UNAVAILABLE', 'PMS 服务暂不可用'), 503],
      [new PmsError('INVALID_RESPONSE', 'PMS 返回错误'), 502],
    ];
    for (const [error, expectedStatus] of cases) {
      failure = error;
      const response = await fetch(`http://127.0.0.1:${port}/api/pms/managed-projects`);
      expect(response.status).toBe(expectedStatus);
      expect(await response.json()).toEqual({ error: { code: error.code, message: error.message } });
    }

    failure = new Error('raw axios config and credentials');
    const response = await fetch(`http://127.0.0.1:${port}/api/pms/managed-projects`);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: { code: 'INVALID_RESPONSE', message: 'PMS 查询失败' } });
  });
});

it('缺少 PMS 依赖返回 503，非本机 Host 被拒绝', async () => {
  let calls = 0;
  const deps = makeDeps(async () => {
    calls++;
    return snapshot;
  });
  await withServer(makeDeps(), async (port) => {
    const uninitialized = await fetch(`http://127.0.0.1:${port}/api/pms/managed-projects`);
    expect(uninitialized.status).toBe(503);
    expect(await uninitialized.json()).toEqual({
      error: { code: 'UPSTREAM_UNAVAILABLE', message: 'PMS 查询未初始化' },
    });
  });
  await withServer(deps, async (port) => {
    const rejected = await requestWithHost(port, 'example.com');
    expect(rejected.status).toBe(403);
    expect(JSON.parse(rejected.body)).toEqual({ error: '仅限本机访问' });
    expect(calls).toBe(0);
  });
});
