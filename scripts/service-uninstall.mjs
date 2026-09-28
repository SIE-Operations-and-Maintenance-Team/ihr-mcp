// 卸载 ihr-mcp Windows 服务（node-windows 自动先停止服务）。需管理员权限——用 service-uninstall.cmd 启动（已自提升）。
import svc from 'node-windows';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { Service } = svc;

const service = new Service({
  name: 'ihr-mcp',
  script: join(root, 'dist', 'index.js'),
});

service.on('uninstall', () => console.log('[完成] 服务已卸载（程序文件与配置不受影响）'));
service.on('error', (err) => {
  console.error('[错误]', err);
  process.exitCode = 1;
});

service.uninstall();
