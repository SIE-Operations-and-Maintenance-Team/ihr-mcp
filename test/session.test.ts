import { describe, it, expect } from 'vitest';
import { SessionManager } from '../src/session.js';
import { SsoLoginResult } from '../src/sso/client.js';

class FakeSso {
  calls = 0;
  result: SsoLoginResult = { success: true, token: 'T1', errorCode: '0', errorMsg: 'ok', passwordExpired: false };
  async login(): Promise<SsoLoginResult> {
    this.calls++;
    return this.result;
  }
}

const cfg = { username: 'u', password: 'p', port: 13210, host: '127.0.0.1', projectsRoot: 'F:\\项目' };

describe('SessionManager', () => {
  it('登录成功后 token 缓存，重复 ensureLogin 不再登录', async () => {
    const fake = new FakeSso();
    const sm = new SessionManager(cfg, fake as any);
    await sm.ensureLogin();
    await sm.ensureLogin();
    expect(fake.calls).toBe(1);
    expect(sm.getTokenInfo().loggedIn).toBe(true);
  });
  it('登录失败抛出含错误码的异常', async () => {
    const fake = new FakeSso();
    fake.result = { success: false, errorCode: '40001', errorMsg: '账号或密码错误', passwordExpired: false };
    const sm = new SessionManager(cfg, fake as any);
    await expect(sm.ensureLogin()).rejects.toThrow('ihr 登录失败: 账号或密码错误 [code=40001]');
  });
  it('密码过期时异常信息带重置提示', async () => {
    const fake = new FakeSso();
    fake.result = { success: false, errorCode: '40009', errorMsg: '密码已过期', passwordExpired: true };
    const sm = new SessionManager(cfg, fake as any);
    await expect(sm.ensureLogin()).rejects.toThrow('重置');
  });
  it('登录失败信息追加凭据配置路径（用户指令）', async () => {
    const fake = new FakeSso();
    fake.result = { success: false, errorCode: '40001', errorMsg: '账号或密码错误', passwordExpired: false };
    const sm = new SessionManager(cfg, fake as any);
    await expect(sm.ensureLogin()).rejects.toThrow(/凭据配置: .+config\.json/);
  });
  it('invalidate 清除 token，ensureLogin 重新登录（服务端吊销 401 恢复路径）', async () => {
    const fake = new FakeSso();
    const sm = new SessionManager(cfg, fake as any);
    await sm.ensureLogin();
    expect(fake.calls).toBe(1);
    sm.invalidate();
    expect(sm.getTokenInfo().loggedIn).toBe(false);
    await sm.ensureLogin();
    expect(fake.calls).toBe(2);
  });
  it('getAuthedHttp 注入 Bearer 头（逆向核心发现：API 只认 Bearer 不认 cookie）', async () => {
    const fake = new FakeSso();
    const sm = new SessionManager(cfg, fake as any);
    const http = await sm.getAuthedHttp();
    expect(http.defaults.headers.common['Authorization']).toBe('Bearer T1');
  });
});
