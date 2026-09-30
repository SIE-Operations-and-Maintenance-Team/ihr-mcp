import { describe, it, expect } from 'vitest';
import { SessionLoginError, SessionManager } from '../src/session.js';
import { SsoLoginResult } from '../src/sso/client.js';

class FakeSso {
  calls = 0;
  result: SsoLoginResult = { success: true, token: 'T1', errorCode: '0', errorMsg: 'ok', passwordExpired: false };
  loginImpl?: () => Promise<SsoLoginResult>;
  async login(): Promise<SsoLoginResult> {
    this.calls++;
    return this.loginImpl ? this.loginImpl() : this.result;
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
  it('并发调用共享一次 SSO 登录', async () => {
    const fake = new FakeSso();
    const sm = new SessionManager(cfg, fake as any);
    await Promise.all([sm.ensureLogin(), sm.ensureLogin(), sm.getAuthedHttp()]);
    expect(fake.calls).toBe(1);
  });
  it('旧会话失效不能清掉新会话', async () => {
    const fake = new FakeSso();
    const sm = new SessionManager(cfg, fake as any);
    expect(sm.invalidateIfToken('')).toBe(false);
    const old = await sm.getSsoSnapshot();
    expect(sm.invalidateIfCurrent(old.generation)).toBe(true);
    fake.result = { ...fake.result, token: 'T2' };
    const fresh = await sm.getSsoSnapshot();
    expect(sm.invalidateIfCurrent(old.generation)).toBe(false);
    expect((await sm.getSsoSnapshot()).token).toBe('T2');
    expect(fresh.generation).toBeGreaterThan(old.generation);
    expect(sm.invalidateIfToken('T1')).toBe(false);
    expect(sm.getTokenInfo().loggedIn).toBe(true);
    expect(sm.invalidateIfToken('T2')).toBe(true);
    expect(sm.getTokenInfo().loggedIn).toBe(false);
  });
  it('登录期间失效的旧结果不会覆盖新会话快照', async () => {
    const fake = new FakeSso();
    let releaseLogin: ((result: SsoLoginResult) => void) | undefined;
    fake.loginImpl = () => new Promise((resolve) => { releaseLogin = resolve; });
    const sm = new SessionManager(cfg, fake as any);
    const pending = sm.getSsoSnapshot();

    sm.invalidate();
    fake.loginImpl = undefined;
    fake.result = { ...fake.result, token: 'T2' };
    releaseLogin!({ success: true, token: 'T1', errorCode: '0', errorMsg: 'ok', passwordExpired: false });

    const fresh = await pending;
    expect(fresh.token).toBe('T2');
    expect(fresh.generation).toBeGreaterThan(1);
    expect(fake.calls).toBe(2);
  });
  it('SSO 登录失败保留错误码并清理在途 Promise，允许后续重试', async () => {
    const fake = new FakeSso();
    fake.result = { success: false, errorCode: '300008', errorMsg: '登录失败', passwordExpired: false };
    const sm = new SessionManager(cfg, fake as any);
    await expect(sm.ensureLogin()).rejects.toBeInstanceOf(SessionLoginError);
    await expect(sm.ensureLogin()).rejects.toMatchObject({ code: '300008' });
    fake.result = { ...fake.result, success: true, token: 'T2', errorCode: '0' };
    await expect(sm.ensureLogin()).resolves.toBe('T2');
    expect(fake.calls).toBe(3);
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
