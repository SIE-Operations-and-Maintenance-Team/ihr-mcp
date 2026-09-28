// 生成离线发布包：dist + 生产依赖 node_modules + 部署 cmd，打成 zip。
// 同事机器无需 npm、无需联网；唯一前提是已安装 Node.js ≥20（服务运行时）。
// 本机数据（config.json/mapping.json）不进包：凭据隔离，同事首启自动生成配置模板。
import { cpSync, rmSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `ihr-mcp-v${pkg.version}`;
const stage = join(root, 'publish', name);
const zipPath = join(root, 'publish', `${name}.zip`);

if (!existsSync(join(root, 'dist', 'index.js'))) {
  console.error('[错误] 未找到 dist/index.js，请先 npm run build');
  process.exit(1);
}

rmSync(stage, { recursive: true, force: true });
rmSync(zipPath, { force: true });
mkdirSync(join(stage, 'dist'), { recursive: true });

// 1. dist（排除本机数据）
cpSync(join(root, 'dist'), join(stage, 'dist'), {
  recursive: true,
  filter: (src) => !src.endsWith('config.json') && !src.endsWith('mapping.json'),
});

// 2. 生产依赖（npm ci 按 lockfile 精确安装；打包机需要 registry 访问，同事机器不需要）
cpSync(join(root, 'package.json'), join(stage, 'package.json'));
cpSync(join(root, 'package-lock.json'), join(stage, 'package-lock.json'));
execSync('npm ci --omit=dev', { cwd: stage, stdio: 'inherit' });

// 3. 部署脚本与 cmd
cpSync(join(root, 'scripts'), join(stage, 'scripts'), { recursive: true });
for (const f of ['service-install.cmd', 'service-uninstall.cmd', 'ihr-service.cmd']) {
  cpSync(join(root, f), join(stage, f));
}

// 4. 打 zip（PowerShell Compress-Archive：Windows 自带；execSync 走 cmd.exe 时 tar 会解析到 Git Bash 的 GNU tar，对 zip 不可靠）
execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path '${stage}\\*' -DestinationPath '${zipPath}' -Force"`,
  { stdio: 'inherit' },
);

// 5. 自检：node-windows 随包、本机数据未混入
for (const mustExist of [
  join(stage, 'node_modules', 'node-windows'),
  join(stage, 'dist', 'index.js'),
  join(stage, 'service-install.cmd'),
]) {
  if (!existsSync(mustExist)) {
    console.error(`[错误] 发布包缺少 ${mustExist}`);
    process.exit(1);
  }
}
for (const mustNotExist of [
  join(stage, 'dist', 'config.json'),
  join(stage, 'dist', 'mapping.json'),
  join(stage, 'node_modules', 'typescript'),
]) {
  if (existsSync(mustNotExist)) {
    console.error(`[错误] 发布包混入了不该带的内容: ${mustNotExist}`);
    process.exit(1);
  }
}

console.log(`[完成] 发布包: ${zipPath}`);
console.log('[说明] 同事解压后双击 service-install.cmd 即可；机器需已安装 Node.js ≥20。首次启动自动生成 config.json 模板，填入账号密码后 ihr-service.cmd restart');
