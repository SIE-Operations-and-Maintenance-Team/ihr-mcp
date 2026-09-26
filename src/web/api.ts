import http from 'node:http';
import { SessionManager } from '../session.js';
import { MappingStore } from '../mapping.js';
import { listProjectsWithMapping, listLocalFolders } from '../service.js';
import { LoadConfigResult } from '../config.js';

export interface WebApiDeps {
  cfg: LoadConfigResult;
  session: SessionManager;
  mapping: MappingStore;
}

export function createWebApi(deps: WebApiDeps) {
  return async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const json = (code: number, payload: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };
    try {
      if (req.method === 'GET' && url.pathname === '/api/status') {
        const t = deps.session.getTokenInfo();
        return json(200, {
          configOk: deps.cfg.configOk,
          username: deps.cfg.username,
          loggedIn: t.loggedIn,
          tokenExpiresAt: t.tokenExpiresAt,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/projects') {
        return json(200, { projects: await listProjectsWithMapping(deps) });
      }
      if (req.method === 'GET' && url.pathname === '/api/local-folders') {
        return json(200, { folders: listLocalFolders(deps.cfg.projectsRoot) });
      }
      if (req.method === 'POST' && url.pathname === '/api/mapping') {
        const body = JSON.parse(await readBody(req));
        const { projectCode, customer } = body ?? {};
        if (typeof projectCode !== 'string' || !projectCode || typeof customer !== 'string' || !customer) {
          return json(400, { error: '需要 {projectCode, customer}' });
        }
        deps.mapping.set(projectCode, customer);
        return json(200, { ok: true });
      }
      return json(404, { error: 'Not Found' });
    } catch (err: any) {
      return json(500, { error: err?.message ?? 'Internal Error' });
    }
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
