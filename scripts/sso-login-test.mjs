// 手动集成测试：SSO 登录 → 用 token 访问 ihr，输出 cookie 与状态。先 npm run build。
import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const cfgPath = join(homedir(), '.ihr-mcp', 'config.json');
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const { encryptPassword } = await import('../dist/sso/crypto.js');

const jar = new CookieJar();
const http = wrapper(axios.create({
  jar,
  timeout: 15000,
  maxRedirects: 0,
  validateStatus: () => true,
}));

// 1. SSO 登录
const login = await http.post('https://my.chinasie.com/certification/api/v1/certificate/login', {
  accountId: cfg.username,
  password: encryptPassword(cfg.password),
  isRememberMe: true,
});
console.log('登录响应:', JSON.stringify(login.data));
if (login.data.errorCode !== '0') process.exit(1);

await jar.setCookie(`token=${login.data.data}; Domain=chinasie.com; Path=/`, 'https://my.chinasie.com/');

// 2. 访问 ihr 首页，观察是否接受 token / 是否下发新 cookie
const ihr = await http.get('http://ihr.chinasie.com/core/');
console.log('ihr /core/ 状态:', ihr.status);
console.log('Location:', ihr.headers.location ?? '(无重定向)');
console.log('set-cookie:', ihr.headers['set-cookie'] ?? '(无)');
console.log('jar 中 ihr cookies:', (await jar.getCookies('http://ihr.chinasie.com/')).map(String));
