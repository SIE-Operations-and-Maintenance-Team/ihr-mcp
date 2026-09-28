// 将 ihr-mcp 安装为 Windows 服务（node-windows 守护）。需管理员权限——用 service-install.cmd 启动（已自提升）。
import svc from 'node-windows';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { Service } = svc;

// 读配置端口（程序根目录，缺省 13210），安装前自动结束占用端口的旧实例（如手动启动的 node 进程）
let port = 13210;
try {
  port = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).port ?? port;
} catch { /* 配置不存在用默认 */ }

try {
  const out = execSync('netstat -ano', { encoding: 'utf8' });
  for (const line of out.split('\n')) {
    if (line.includes(`:${port} `) && line.includes('LISTENING')) {
      const pid = line.trim().split(/\s+/).pop();
      if (pid && pid !== '0') {
        console.log(`[提示] 端口 ${port} 被进程 ${pid} 占用（可能是手动启动的实例），自动结束...`);
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      }
    }
  }
} catch { /* 无占用或 netstat 失败，不阻塞安装 */ }

const service = new Service({
  name: 'ihr-mcp',
  id: 'ihr-mcp', // 显式指定服务内部名（不设时 node-windows 会生成 ihrmcp.exe 之类的名字）
  description: 'ihr 考勤自动填报 MCP 服务端（Streamable HTTP + Web 管理页）',
  script: join(root, 'dist', 'index.js'),
  scriptOptions: '-t http',
});

service.on('install', () => {
  console.log('[完成] 服务安装成功，正在启动...');
  service.start();
});
service.on('alreadyinstalled', () => {
  console.log('[提示] 服务已存在。如需重装请先运行 service-uninstall.cmd');
});
service.on('start', () => {
  console.log('[完成] 服务已启动（开机自启）。配置: 程序根目录 config.json，管理页: http://127.0.0.1:' + port + '/');
});
service.on('error', (err) => {
  console.error('[错误]', err);
  process.exitCode = 1;
});

service.install();
