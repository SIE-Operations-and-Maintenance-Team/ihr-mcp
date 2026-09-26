import axios, { AxiosInstance, AxiosResponse } from 'axios';
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
    let resp: AxiosResponse;
    try {
      resp = await this.http.post(SSO_LOGIN_PATH, {
        accountId: username,
        password: encryptPassword(password),
        isRememberMe: true,
      });
    } catch (err: any) {
      // HTTP 非 2xx（AxiosError 带 response）与网络错误/超时（无 response）统一转为失败结果，
      // 保证 login() 恒解析出结果对象（SessionManager 按 !r.success 分支消费）
      return {
        success: false,
        errorCode: err?.response ? `HTTP_${err.response.status}` : 'NETWORK',
        errorMsg: err?.response?.data?.errorMsg || err?.message || '网络错误',
        passwordExpired: false,
      };
    }
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
