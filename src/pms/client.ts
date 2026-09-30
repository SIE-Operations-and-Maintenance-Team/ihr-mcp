import axios, { AxiosInstance } from 'axios';
import type { SsoSnapshot } from '../session.js';

export type PmsErrorCode = 'AUTH_REQUIRED' | 'UPSTREAM_UNAVAILABLE' | 'INVALID_RESPONSE';

export class PmsError extends Error {
  constructor(public readonly code: PmsErrorCode, message: string) {
    super(message);
    this.name = 'PmsError';
  }
}

export interface ManagedProject {
  projectId: string;
  projectCode: string;
  projectName: string;
  status: string;
  planStartDate: string | null;
  planEndDate: string | null;
}

export interface ProjectPage {
  projects: ManagedProject[];
  totalPages: number;
  currentPage: number;
}

export interface ProjectSnapshot {
  schemaVersion: 1;
  sourceAccount: string;
  fetchedAt: string;
  complete: true;
  projects: ManagedProject[];
}

export const PMS_LIST_PATH = '/pms/11Index/api/portal/project/list';
const PMS_BASE_URL = 'https://pms.chinasie.com';
const PAGE_TIMEOUT_MS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(message: string): never {
  throw new PmsError('INVALID_RESPONSE', message);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    return invalidResponse(`PMS 项目字段 ${field} 缺失或无效`);
  }
  return value;
}

function projectId(value: unknown): string {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return invalidResponse('PMS 项目 ID 缺失或超出安全范围');
}

export function shanghaiDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PmsError('INVALID_RESPONSE', '项目日期不是毫秒时间戳');
  }
  const shifted = new Date(value + 8 * 3_600_000);
  if (!Number.isFinite(shifted.getTime())) {
    throw new PmsError('INVALID_RESPONSE', '项目日期超出范围');
  }
  const date = shifted.toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new PmsError('INVALID_RESPONSE', '项目日期不能表示为 YYYY-MM-DD');
  }
  return date;
}

function parseProject(raw: unknown): ManagedProject {
  if (!isRecord(raw) || !isRecord(raw.project) || !isRecord(raw.status)) {
    return invalidResponse('PMS 项目结构无效');
  }
  return {
    projectId: projectId(raw.project.id),
    projectCode: requiredText(raw.project.code, 'project.code'),
    projectName: requiredText(raw.project.name, 'project.name'),
    status: requiredText(raw.status.name, 'status.name'),
    planStartDate: shanghaiDate(raw.planBeginTime),
    planEndDate: shanghaiDate(raw.planEndTime),
  };
}

export function parseProjectPage(raw: unknown, requestedPage: number): ProjectPage {
  if (!isRecord(raw)) return invalidResponse('PMS 响应不是对象');
  if (raw.code === 'E000001') {
    throw new PmsError('AUTH_REQUIRED', 'PMS 需要有效的 SSO 登录');
  }
  if (raw.code !== 'success') {
    throw new PmsError('INVALID_RESPONSE', 'PMS 返回未识别业务错误');
  }
  if (!Array.isArray(raw.data) || !isRecord(raw.page)) {
    return invalidResponse('PMS 项目列表或分页信息缺失');
  }

  const currentPage = raw.page.currentPage;
  const totalPages = raw.page.totalPages;
  if (!Number.isSafeInteger(currentPage) || (currentPage as number) < 1) {
    return invalidResponse('PMS 当前页码无效');
  }
  if (currentPage !== requestedPage) {
    return invalidResponse('PMS 返回页码与请求不一致');
  }
  if (!Number.isSafeInteger(totalPages) || (totalPages as number) < 0) {
    return invalidResponse('PMS 总页数无效');
  }

  return {
    currentPage: currentPage as number,
    totalPages: totalPages as number,
    projects: raw.data.map(parseProject),
  };
}

export class PmsClient {
  constructor(
    private http: AxiosInstance = axios.create({
      baseURL: PMS_BASE_URL,
      timeout: PAGE_TIMEOUT_MS,
      maxRedirects: 0,
    }),
  ) {}

  async listPage(sso: SsoSnapshot, pageNo: number, signal: AbortSignal): Promise<ProjectPage> {
    let response;
    try {
      response = await this.http.post(PMS_LIST_PATH, {
        attended: false,
        iAmProjectManager: true,
        recentVisit: false,
        orderBy: '',
        orderType: 'DESC',
        pageNo,
        pageSize: 20,
        personOverview: true,
        processing: false,
        iAmManager: false,
      }, {
        headers: {
          Cookie: `token=${sso.token}`,
          'Content-Type': 'application/json;charset=UTF-8',
        },
        timeout: PAGE_TIMEOUT_MS,
        maxRedirects: 0,
        signal,
      });
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === undefined || status >= 500 || err?.code === 'ECONNABORTED' || err?.code === 'ERR_CANCELED') {
        throw new PmsError('UPSTREAM_UNAVAILABLE', 'PMS 服务暂不可用');
      }
      throw new PmsError('INVALID_RESPONSE', `PMS 请求失败（HTTP ${status}）`);
    }

    if (response.status >= 500) {
      throw new PmsError('UPSTREAM_UNAVAILABLE', 'PMS 服务暂不可用');
    }
    if (response.status < 200 || response.status >= 300) {
      throw new PmsError('INVALID_RESPONSE', `PMS 请求失败（HTTP ${response.status}）`);
    }
    return parseProjectPage(response.data, pageNo);
  }
}
