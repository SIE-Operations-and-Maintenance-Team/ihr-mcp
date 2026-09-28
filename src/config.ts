import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

export interface Config {
  username: string;
  password: string;
  port: number;
  host: string;
  projectsRoot: string;
}

export interface LoadConfigResult extends Config {
  configOk: boolean;
}

const DEFAULTS = { port: 3210, host: '127.0.0.1', projectsRoot: 'F:\\项目' };

// writeConfigTemplate 写入的占位符：非空但不算已配置真实凭据
const USERNAME_PLACEHOLDER = '在此填入ihr用户名';
const PASSWORD_PLACEHOLDER = '在此填入ihr密码';

// 配置文件位于编译产物目录（与 dist/index.js 同级）；返回模块自身目录，与启动时的工作目录无关
export function configDir(): string {
  return dirname(fileURLToPath(import.meta.url));
}

export function defaultConfigPath(): string {
  return join(configDir(), 'config.json');
}

export function loadConfig(path: string = defaultConfigPath()): LoadConfigResult {
  if (!existsSync(path)) {
    return { username: '', password: '', ...DEFAULTS, configOk: false };
  }
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return {
    username: raw.username ?? '',
    password: raw.password ?? '',
    port: raw.port ?? DEFAULTS.port,
    host: raw.host ?? DEFAULTS.host,
    projectsRoot: raw.projectsRoot ?? DEFAULTS.projectsRoot,
    configOk: Boolean(
      raw.username && raw.password
      && raw.username !== USERNAME_PLACEHOLDER
      && raw.password !== PASSWORD_PLACEHOLDER,
    ),
  };
}

export function writeConfigTemplate(path: string = defaultConfigPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    username: USERNAME_PLACEHOLDER,
    password: PASSWORD_PLACEHOLDER,
    port: 3210,
    host: '127.0.0.1',
    projectsRoot: 'F:\\项目',
  }, null, 2), 'utf8');
}

// 启动时调用：程序目录下无 config.json 才生成占位符模板（编译时不会生成配置）；已存在则不碰。返回是否新生成
export function ensureConfigTemplate(path: string = defaultConfigPath()): boolean {
  if (existsSync(path)) return false;
  writeConfigTemplate(path);
  return true;
}

// 服务监听地址优先级：命令行参数 > config.json > 内置默认（3210/127.0.0.1）
export function resolveServerAddress(
  cfg: { port?: number; host?: string },
  cli?: { port?: string; host?: string },
): { port: number; host: string } {
  return {
    port: cli?.port !== undefined ? parseInt(cli.port, 10) : cfg.port ?? 3210,
    host: cli?.host !== undefined ? cli.host : cfg.host ?? '127.0.0.1',
  };
}
