import { describe, it, expect } from 'vitest';
import axios from 'axios';
import { SsoClient } from '../../src/sso/client.js';

function clientWithResponse(status: number, data: unknown): SsoClient {
  const http = axios.create({
    adapter: (async (config: any) => ({
      data,
      status,
      statusText: 'OK',
      headers: {},
      config,
    })) as any,
  });
  return new SsoClient(http);
}

describe('SsoClient.login', () => {
  it('errorCode=0 且有 data 时登录成功返回 token', async () => {
    const c = clientWithResponse(200, { errorCode: '0', errorMsg: 'ok', data: 'TOKEN123' });
    const r = await c.login('user', 'pass');
    expect(r.success).toBe(true);
    expect(r.token).toBe('TOKEN123');
    expect(r.passwordExpired).toBe(false);
  });
  it('errorCode!=0 时失败并带回服务端错误信息', async () => {
    const c = clientWithResponse(200, { errorCode: '40001', errorMsg: '账号或密码错误' });
    const r = await c.login('user', 'wrong');
    expect(r.success).toBe(false);
    expect(r.errorMsg).toBe('账号或密码错误');
  });
  it('errorCode=40009 标记密码过期', async () => {
    const c = clientWithResponse(200, { errorCode: '40009', errorMsg: '密码已过期' });
    const r = await c.login('user', 'pass');
    expect(r.success).toBe(false);
    expect(r.passwordExpired).toBe(true);
  });
  it('HTTP 500 时失败并带回服务端错误信息', async () => {
    // 模拟内置 http adapter 对非 2xx 的行为：settle 以带 response 的 AxiosError reject
    const http = axios.create({
      adapter: (async (config: any) => {
        const err: any = new Error('Request failed with status code 500');
        err.response = { data: { errorMsg: '服务异常' }, status: 500, statusText: 'Internal Server Error', headers: {}, config };
        throw err;
      }) as any,
    });
    const c = new SsoClient(http);
    const r = await c.login('user', 'pass');
    expect(r.success).toBe(false);
    expect(r.errorCode).toBe('HTTP_500');
    expect(r.errorMsg).toBe('服务异常');
  });
  it('网络错误（adapter 抛异常）时失败并带回错误信息', async () => {
    const http = axios.create({
      adapter: (async () => {
        throw new Error('connect ECONNREFUSED');
      }) as any,
    });
    const c = new SsoClient(http);
    const r = await c.login('user', 'pass');
    expect(r.success).toBe(false);
    expect(r.errorMsg).toBe('connect ECONNREFUSED');
  });
});
