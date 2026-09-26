import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
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

export function configDir(): string {
  return join(homedir(), '.ihr-mcp');
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
