import axios, { AxiosInstance } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { SsoClient } from './sso/client.js';
import { Config, defaultConfigPath } from './config.js';

// isRememberMe=true 时 SSO token 有效期 7 天，提前 1 分钟视为过期
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface SsoSnapshot {
  token: string;
  generation: number;
}

export class SessionLoginError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'SessionLoginError';
  }
}

export class SessionManager {
  private jar = new CookieJar();
  private token?: string;
  private tokenExpiresAt = 0;
  private loginPromise?: Promise<string>;
  private generation = 0;
  private http: AxiosInstance;

  constructor(
    private cfg: Config,
    private sso: SsoClient = new SsoClient(),
  ) {
    this.http = wrapper(axios.create({
      baseURL: 'https://ihr.chinasie.com', // http 会 301 到 https（逆向结果 §0）
      jar: this.jar, // 保留 cookie 无害；API 实际鉴权走 Bearer 头（见 getAuthedHttp）
      timeout: 20000,
    }));
  }

  async ensureLogin(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (this.loginPromise) return this.loginPromise;

    const loginGeneration = this.generation;
    const loginPromise = (async () => {
      const r = await this.sso.login(this.cfg.username, this.cfg.password);
      if (!r.success) {
        const hint = r.passwordExpired ? '（密码已过期，请到 https://my.chinasie.com/certification/ 重置）' : '';
        throw new SessionLoginError(
          r.errorCode,
          `ihr 登录失败: ${r.errorMsg} [code=${r.errorCode}]${hint}（凭据配置: ${defaultConfigPath()}）`,
        );
      }
      if (!r.token) {
        throw new SessionLoginError('INVALID_RESPONSE', 'ihr 登录失败: SSO 响应缺少 token');
      }
      if (this.generation !== loginGeneration) {
        throw new SessionLoginError('SESSION_CHANGED', '登录期间会话状态已变化，请重试');
      }

      this.token = r.token;
      this.tokenExpiresAt = Date.now() + TOKEN_TTL_MS - 60_000;
      this.generation++;
      const installedGeneration = this.generation;
      await this.jar.setCookie(`token=${r.token}; Domain=chinasie.com; Path=/`, 'https://my.chinasie.com/');
      if (this.generation !== installedGeneration || this.token !== r.token) {
        throw new SessionLoginError('SESSION_CHANGED', '登录期间会话状态已变化，请重试');
      }
      return r.token;
    })();

    this.loginPromise = loginPromise;
    try {
      return await loginPromise;
    } finally {
      if (this.loginPromise === loginPromise) this.loginPromise = undefined;
    }
  }

  async getSsoSnapshot(): Promise<SsoSnapshot> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const token = await this.ensureLogin();
        if (this.token === token && Date.now() < this.tokenExpiresAt) {
          return { token, generation: this.generation };
        }
      } catch (err) {
        if (!(err instanceof SessionLoginError && err.code === 'SESSION_CHANGED') || attempt === 1) {
          throw err;
        }
      }
    }
    throw new SessionLoginError('SESSION_CHANGED', '会话状态持续变化，请重试');
  }

  // token 被服务端吊销（ihr errorCode=401）时由 withReauth 调用，强制下次 ensureLogin 重新登录
  invalidate(): void {
    this.token = undefined;
    this.tokenExpiresAt = 0;
    this.generation++;
  }

  invalidateIfCurrent(generation: number): boolean {
    if (this.generation !== generation || !this.token) return false;
    this.invalidate();
    return true;
  }

  invalidateIfToken(token: string): boolean {
    if (!token || this.token !== token) return false;
    this.invalidate();
    return true;
  }

  async getAuthedHttp(): Promise<AxiosInstance> {
    const { token } = await this.getSsoSnapshot();
    // ihr API 鉴权只认 Authorization: Bearer 头，不认 cookie（逆向结果"会话建立"节实测矩阵）
    this.http.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    return this.http;
  }

  getTokenInfo(): { loggedIn: boolean; tokenExpiresAt: number } {
    return {
      loggedIn: Boolean(this.token && Date.now() < this.tokenExpiresAt),
      tokenExpiresAt: this.tokenExpiresAt,
    };
  }
}
