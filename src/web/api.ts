import http from 'node:http';
import { spawn, execSync } from 'node:child_process';
import { SessionManager } from '../session.js';
import { MappingStore } from '../mapping.js';
import { listProjectsWithMapping, listLocalFolders } from '../service.js';
import { updateConfig, defaultConfigPath, LoadConfigResult } from '../config.js';

export interface WebApiDeps {
  cfg: LoadConfigResult;
  session: SessionManager;
  mapping: MappingStore;
}

// Web API 仅限本机访问：Host 必须为 127.0.0.1/localhost/[::1]（可带端口），防跨主机调用/DNS rebinding
const LOCAL_HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

export function createWebApi(deps: WebApiDeps) {
  return async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const json = (code: number, payload: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
    };
    if (!LOCAL_HOST_RE.test(req.headers.host ?? '')) {
      return json(403, { error: '仅限本机访问' });
    }
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
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
      if (req.method === 'GET' && url.pathname === '/api/config') {
        // 不含 password：表单留空 = 保持现有密码
        return json(200, {
          username: deps.cfg.username,
          projectsRoot: deps.cfg.projectsRoot,
          host: deps.cfg.host,
          port: deps.cfg.port,
          configPath: defaultConfigPath(),
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/config') {
        const body = JSON.parse(await readBody(req));
        const updated = updateConfig(body ?? {});
        return json(200, { ok: true, configPath: defaultConfigPath(), username: updated.username });
      }
      if (req.method === 'POST' && url.pathname === '/api/restart') {
        // 先应答再自重启：服务模式 net stop/start；手动模式延时后自拉起同参数新进程
        json(200, { ok: true, message: '服务重启中，约 3 秒后恢复' });
        scheduleRestart();
        return;
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

// 保存配置后的自重启：Windows 服务运行中走 net stop/start（分离的延时 cmd）；
// 手动运行则延时自拉起同参数新进程（旧进程先退出释放端口，新进程延后绑定）
function scheduleRestart(): void {
  setTimeout(() => {
    try {
      const out = execSync('sc query ihr-mcp', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (out.includes('RUNNING')) {
        spawn('cmd.exe', ['/c', 'timeout /t 1 >nul & net stop ihr-mcp & net start ihr-mcp'], {
          detached: true,
          stdio: 'ignore',
        }).unref();
        setTimeout(() => process.exit(0), 300);
        return;
      }
    } catch { /* 服务未安装或查询失败 → 按手动模式处理 */ }
    const nodeArgs = process.argv.slice(1).map((a) => `"${a}"`).join(' ');
    spawn('cmd.exe', ['/c', `timeout /t 2 >nul & "${process.execPath}" ${nodeArgs}`], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    process.exit(0);
  }, 300);
}
