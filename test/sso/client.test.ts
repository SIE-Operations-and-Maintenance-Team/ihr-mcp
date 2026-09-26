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
});
