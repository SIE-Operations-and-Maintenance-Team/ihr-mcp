import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uninstallService } from './service-control.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
uninstallService(root).then(() => {
  console.log('[完成] 服务注册已清除，守护已隔离；程序文件与配置保留');
}).catch(error => {
  console.error('[错误] ' + error.message);
  process.exitCode = 1;
});
