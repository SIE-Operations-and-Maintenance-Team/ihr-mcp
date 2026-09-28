import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { serviceFor, assertDaemon, normalizePath } from './service-state.mjs';

const localFiles = ['config.json', 'mapping.json'];
const daemonFiles = [
  'dist/daemon/ihrmcp.exe', 'dist/daemon/ihrmcp.xml', 'dist/daemon/ihrmcp.exe.config',
];
const allowed = new Set([...localFiles, ...daemonFiles]);
const digest = value => createHash('sha256').update(value).digest('hex');

function createBackup(root, files) {
  mkdirSync(dirname(root), { recursive: true });
  const backupDir = mkdtempSync(join(dirname(root), '.ihr-deploy-backup-'));
  try {
    const entries = [];
    for (const rel of files) {
      const source = join(root, rel);
      if (!lstatSync(source).isFile()) throw new Error('不能备份非普通文件：' + source);
      const bytes = readFileSync(source);
      const target = join(backupDir, 'files', rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      if (!readFileSync(target).equals(bytes)) throw new Error('备份校验失败：' + rel);
      entries.push({ rel, sha256: digest(bytes) });
    }
    writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify({
      root: resolve(root), entries,
    }, null, 2), 'utf8');
    return backupDir;
  } catch (error) {
    throw new Error('备份失败，原部署未重建；检查 ' + backupDir, { cause: error });
  }
}

export function restoreBackup(root, backupDir) {
  const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'));
  if (normalizePath(manifest.root) !== normalizePath(root)
      || !Array.isArray(manifest.entries)
      || manifest.entries.some(entry => !allowed.has(entry.rel)
        || !/^[0-9a-f]{64}$/.test(entry.sha256))
      || new Set(manifest.entries.map(entry => entry.rel)).size !== manifest.entries.length) {
    throw new Error('备份清单与目标部署不匹配');
  }
  const errors = [];
  for (const entry of manifest.entries) {
    try {
      const bytes = readFileSync(join(backupDir, 'files', entry.rel));
      if (digest(bytes) !== entry.sha256) throw new Error('备份内容校验失败：' + entry.rel);
      const target = join(root, entry.rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      if (!readFileSync(target).equals(bytes)) throw new Error('还原校验失败：' + entry.rel);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, '还原失败，保持停服，备份保留在 ' + backupDir);
  }
}

export function withPreservedDeployment(root, build) {
  root = resolve(root);
  const service = serviceFor(root, undefined, true);
  const daemonDir = join(root, 'dist', 'daemon');
  if (service && service.State !== 'Stopped') {
    throw new Error('请先停止服务并确认 Stopped：' + service.Name);
  }
  if (!service && existsSync(daemonDir)) {
    throw new Error('发现孤立 daemon，请先使用 service-uninstall.cmd 处理残留');
  }
  if (service) assertDaemon(root, service);
  const files = localFiles.filter(rel => existsSync(join(root, rel)));
  if (service) files.push(...daemonFiles);
  for (const rel of files) {
    if (!lstatSync(join(root, rel)).isFile()) throw new Error('部署文件不是普通文件：' + rel);
  }
  const backupDir = files.length ? createBackup(root, files) : null;
  let value, buildError, restoreError;
  try {
    value = build();
  } catch (error) {
    buildError = error;
  } finally {
    if (backupDir) {
      try { restoreBackup(root, backupDir); } catch (error) { restoreError = error; }
    }
  }
  if (restoreError) {
    throw new AggregateError([buildError, restoreError].filter(Boolean),
      '还原失败，保持停服，备份保留在 ' + backupDir);
  }
  if (buildError) {
    throw new Error(buildError.message + '；部署可能不完整，保持停服；备份：'
      + (backupDir || '原目录无待保留文件'), { cause: buildError });
  }
  return { value, backupDir };
}
