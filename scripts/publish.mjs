import { cpSync, rmSync, mkdirSync, existsSync, readFileSync, renameSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { withPreservedDeployment } from './publish-preserve.mjs';
import { powerShellJson, normalizePath } from './service-state.mjs';

export function publish(repoRoot) {
  const root = resolve(repoRoot);
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!/^[0-9A-Za-z.+-]+$/.test(pkg.version)) throw new Error('版本号不能构成目录路径');
  if (!existsSync(join(root, 'dist', 'index.js'))) throw new Error('请先执行 npm run build');
  const name = 'ihr-mcp-v' + pkg.version;
  const stage = join(root, 'publish', name);
  const zipPath = join(root, 'publish', name + '.zip');
  const pendingZip = join(root, 'publish', name + '.pending.zip');
  if (!normalizePath(stage).startsWith(normalizePath(join(root, 'publish')) + '\\')) {
    throw new Error('发布目录越界');
  }
  let outcome;
  try {
    outcome = withPreservedDeployment(stage, () => {
      // 失败就退出保护区并还原，不在部分删除后再无条件清空每一个条目。
      rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      rmSync(pendingZip, { force: true, maxRetries: 5, retryDelay: 200 });
      mkdirSync(join(stage, 'dist'), { recursive: true });
      cpSync(join(root, 'dist'), join(stage, 'dist'), {
        recursive: true,
        filter: src => {
          const rel = src.slice(root.length).replaceAll('\\', '/');
          return !/^\/dist\/daemon(\/|$)/.test(rel)
            && !src.endsWith('config.json') && !src.endsWith('mapping.json');
        },
      });
      for (const file of ['package.json', 'package-lock.json'])
        cpSync(join(root, file), join(stage, file));
      execSync('npm ci --omit=dev', { cwd: stage, stdio: 'inherit', windowsHide: true });
      cpSync(join(root, 'scripts'), join(stage, 'scripts'), { recursive: true });
      for (const file of ['service-install.cmd', 'service-uninstall.cmd', 'ihr-service.cmd'])
        cpSync(join(root, file), join(stage, file));
      cpSync(join(root, 'skill'), join(stage, 'skill'), { recursive: true });

      for (const rel of ['node_modules/node-windows', 'dist/index.js', 'service-install.cmd']) {
        if (!existsSync(join(stage, rel))) throw new Error('发布包缺少 ' + rel);
      }
      for (const rel of ['config.json', 'mapping.json', 'dist/daemon', 'node_modules/typescript']) {
        if (existsSync(join(stage, rel))) throw new Error('发布包混入本机文件或开发依赖：' + rel);
      }
      powerShellJson([
        '$paths = @(Get-ChildItem -LiteralPath $env:IHR_PUBLISH_STAGE | Select-Object -ExpandProperty FullName)',
        'Compress-Archive -LiteralPath $paths -DestinationPath $env:IHR_PUBLISH_ZIP -Force -ErrorAction Stop',
        'Add-Type -AssemblyName System.IO.Compression.FileSystem',
        '$archive = [System.IO.Compression.ZipFile]::OpenRead($env:IHR_PUBLISH_ZIP)',
        'try {',
        '  $names = @($archive.Entries | ForEach-Object { $_.FullName.Replace("\\", "/") })',
        '  if ($names | Where-Object { $_ -match "^(config\\.json|mapping\\.json)$|^dist/daemon(/|$)|^node_modules/typescript(/|$)" }) { throw "ZIP contains local data or dev dependencies" }',
        '  foreach ($required in @("dist/index.js", "service-install.cmd", "node_modules/node-windows/package.json")) {',
        '    if ($names -notcontains $required) { throw ("ZIP missing " + $required) }',
        '  }',
        '} finally { $archive.Dispose() }',
        'ConvertTo-Json -InputObject $true',
      ], { IHR_PUBLISH_STAGE: stage, IHR_PUBLISH_ZIP: pendingZip }, 120000);
      return pendingZip;
    });
    // 仅在归档校验和部署还原均成功后发布最终文件；不预先删除旧有效包。
    renameSync(pendingZip, zipPath);
  } catch (error) {
    try { rmSync(pendingZip, { force: true, maxRetries: 5, retryDelay: 200 }); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError],
        '发布失败且临时 ZIP 清理失败，禁止分发：' + pendingZip);
    }
    throw error;
  }
  console.log('[完成] 发布包：' + zipPath);
  if (outcome.backupDir) console.log('[说明] 部署备份：' + outcome.backupDir);
  console.log('[说明] 原服务保持停止；确认发布成功后执行 ihr-service.cmd start。');
  console.log('[说明] 同事解压后运行 service-install.cmd；需 Node.js ≥20；本机配置未进入 ZIP。');
  console.log('[说明] 考勤 skill 源在包内 skill/ihr-attendance，按所用 agent 的技能目录安装。');
  return zipPath;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { publish(join(dirname(fileURLToPath(import.meta.url)), '..')); }
  catch (error) {
    console.error('[错误] ' + error.message);
    process.exitCode = 1;
  }
}
