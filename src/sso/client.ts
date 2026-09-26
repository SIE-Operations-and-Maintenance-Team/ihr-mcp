import axios, { AxiosInstance } from 'axios';
import { encryptPassword } from './crypto.js';

export interface SsoLoginResult {
  success: boolean;
  token?: string;
  errorCode: string;
  errorMsg: string;
  passwordExpired: boolean;
}

export const SSO_BASE_URL = 'https://my.chinasie.com';
export const SSO_LOGIN_PATH = '/certification/api/v1/certificate/login';

export class SsoClient {
  constructor(
    private http: AxiosInstance = axios.create({ baseURL: SSO_BASE_URL, timeout: 15000 }),
  ) {}

  async login(username: string, password: string): Promise<SsoLoginResult> {
    const resp = await this.http.post(SSO_LOGIN_PATH, {
      accountId: username,
      password: encryptPassword(password),
      isRememberMe: true,
    });
    const body = resp.data ?? {};
    if (body.errorCode === '0' && body.data) {
      return {
        success: true,
        token: body.data,
        errorCode: '0',
        errorMsg: body.errorMsg || 'ok',
        passwordExpired: false,
      };
    }
    return {
      success: false,
      errorCode: String(body.errorCode ?? resp.status),
      errorMsg: body.errorMsg || `登录失败 HTTP ${resp.status}`,
      passwordExpired: body.errorCode === '40009',
    };
  }
}
