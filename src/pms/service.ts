import type { SessionManager, SessionLoginError, SsoSnapshot } from '../session.js';
import { PmsClient, PmsError, ProjectPage, ProjectSnapshot } from './client.js';

const SYNC_TIMEOUT_MS = 120_000;
const MAX_PAGES = 100;

function invalid(message: string): never {
  throw new PmsError('INVALID_RESPONSE', message);
}

function mapSessionError(err: unknown): PmsError {
  if (err instanceof PmsError) return err;
  if (!(err instanceof Error) || !('code' in err)) {
    return new PmsError('UPSTREAM_UNAVAILABLE', '无法取得 PMS 登录状态');
  }

  const code = String((err as SessionLoginError).code);
  if (code === 'NETWORK' || code === 'SESSION_CHANGED' || /^HTTP_5\d{2}$/.test(code)) {
    return new PmsError('UPSTREAM_UNAVAILABLE', 'SSO 服务暂不可用');
  }
  if (code === '40001' || code === '40009') {
    return new PmsError('AUTH_REQUIRED', 'SSO 账号或密码需要更新');
  }
  return new PmsError('INVALID_RESPONSE', 'SSO 返回未识别的登录错误');
}

function waitForSsoSnapshot(session: SessionManager, signal: AbortSignal): Promise<SsoSnapshot> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new PmsError('UPSTREAM_UNAVAILABLE', 'PMS 项目同步超时'));
      return;
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(new PmsError('UPSTREAM_UNAVAILABLE', 'PMS 项目同步超时'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    session.getSsoSnapshot().then(
      (snapshot) => {
        cleanup();
        resolve(snapshot);
      },
      (err) => {
        cleanup();
        reject(err);
      },
    );
  });
}

export async function collectProjects(
  fetchPage: (pageNo: number) => Promise<ProjectPage>,
): Promise<ProjectPage['projects']> {
  const first = await fetchPage(1);
  if (first.currentPage !== 1) return invalid('PMS 返回页码与请求不一致');
  if (!Number.isSafeInteger(first.totalPages) || first.totalPages < 0) {
    return invalid('PMS 总页数无效');
  }
  if (first.totalPages > MAX_PAGES) return invalid('PMS 项目页数超过 100 页上限');
  if (first.totalPages === 0) {
    if (first.projects.length !== 0) return invalid('PMS 空分页包含项目数据');
    return [];
  }
  if (first.totalPages > 1 && first.projects.length === 0) {
    return invalid('PMS 非末页没有项目数据');
  }

  const projects: ProjectPage['projects'] = [];
  const projectIds = new Map<string, string>();
  const projectCodes = new Map<string, string>();

  const appendPage = (page: ProjectPage, pageNo: number): number => {
    if (page.currentPage !== pageNo) return invalid('PMS 返回页码与请求不一致');
    if (page.totalPages !== first.totalPages) return invalid('PMS 总页数在分页期间发生变化');
    if (pageNo < first.totalPages && page.projects.length === 0) {
      return invalid('PMS 非末页没有项目数据');
    }

    let added = 0;
    for (const project of page.projects) {
      const existingCode = projectIds.get(project.projectId);
      if (existingCode !== undefined) {
        if (existingCode !== project.projectCode) {
          return invalid('相同 PMS 项目 ID 对应不同项目编号');
        }
        continue;
      }
      const existingId = projectCodes.get(project.projectCode);
      if (existingId !== undefined && existingId !== project.projectId) {
        return invalid('不同 PMS 项目 ID 对应相同项目编号');
      }
      projectIds.set(project.projectId, project.projectCode);
      projectCodes.set(project.projectCode, project.projectId);
      projects.push(project);
      added++;
    }
    return added;
  };

  appendPage(first, 1);
  for (let pageNo = 2; pageNo <= first.totalPages; pageNo++) {
    const page = await fetchPage(pageNo);
    if (appendPage(page, pageNo) === 0) {
      return invalid('PMS 分页没有新增项目，停止无进展翻页');
    }
  }
  return projects;
}

export async function listManagedProjects(deps: {
  session: SessionManager;
  sourceAccount: string;
  client: PmsClient;
}): Promise<ProjectSnapshot> {
  const controller = new AbortController();
  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  const ensureTimeRemaining = () => {
    if (controller.signal.aborted || Date.now() >= deadline) {
      controller.abort();
      throw new PmsError('UPSTREAM_UNAVAILABLE', 'PMS 项目同步超时');
    }
  };

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      ensureTimeRemaining();
      let sso: SsoSnapshot;
      try {
        sso = await waitForSsoSnapshot(deps.session, controller.signal);
        ensureTimeRemaining();
      } catch (err) {
        throw mapSessionError(err);
      }

      try {
        const projects = await collectProjects(async (pageNo) => {
          ensureTimeRemaining();
          return deps.client.listPage(sso, pageNo, controller.signal);
        });
        ensureTimeRemaining();
        return {
          schemaVersion: 1,
          sourceAccount: deps.sourceAccount,
          fetchedAt: new Date().toISOString(),
          complete: true,
          projects,
        };
      } catch (err) {
        if (!(err instanceof PmsError && err.code === 'AUTH_REQUIRED') || attempt === 1) {
          throw err;
        }
        deps.session.invalidateIfCurrent(sso.generation);
      }
    }
    throw new PmsError('AUTH_REQUIRED', 'PMS 认证失败');
  } finally {
    clearTimeout(timeout);
  }
}
