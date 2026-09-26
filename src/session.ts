import axios, { AxiosInstance } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { SsoClient } from './sso/client.js';
import { Config } from './config.js';

// isRememberMe=true 时 SSO token 有效期 7 天，提前 1 分钟视为过期
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class SessionManager {
  private jar = new CookieJar();
  private token?: string;
  private tokenExpiresAt = 0;
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
    const r = await this.sso.login(this.cfg.username, this.cfg.password);
    if (!r.success) {
      const hint = r.passwordExpired ? '（密码已过期，请到 https://my.chinasie.com/certification/ 重置）' : '';
      throw new Error(`ihr 登录失败: ${r.errorMsg} [code=${r.errorCode}]${hint}`);
    }
    this.token = r.token!;
    this.tokenExpiresAt = Date.now() + TOKEN_TTL_MS - 60_000;
    await this.jar.setCookie(`token=${this.token}; Domain=chinasie.com; Path=/`, 'https://my.chinasie.com/');
    return this.token;
  }

  async getAuthedHttp(): Promise<AxiosInstance> {
    await this.ensureLogin();
    // ihr API 鉴权只认 Authorization: Bearer 头，不认 cookie（逆向结果"会话建立"节实测矩阵）
    this.http.defaults.headers.common['Authorization'] = `Bearer ${this.token}`;
    return this.http;
  }

  getTokenInfo(): { loggedIn: boolean; tokenExpiresAt: number } {
    return {
      loggedIn: Boolean(this.token && Date.now() < this.tokenExpiresAt),
      tokenExpiresAt: this.tokenExpiresAt,
    };
  }
}
