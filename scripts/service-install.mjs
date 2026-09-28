import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installService } from './service-control.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
installService(root).then(() => {
  console.log('[完成] 服务已安装并通过启动验证');
}).catch(error => {
  console.error('[错误] ' + error.message);
  process.exitCode = 1;
});
