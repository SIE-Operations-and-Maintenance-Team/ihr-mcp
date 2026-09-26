import crypto from 'node:crypto';

// 与 SSO 前端 umi.js 中的加密逻辑保持一致：AES-128-CBC + Pkcs7，输出 hex
const KEY = Buffer.from('UcksX3W5Gs579EYk', 'utf8');
const IV = Buffer.from('QWhShl9eGMvzoP5Y', 'utf8');

export function encryptPassword(plain: string): string {
  const cipher = crypto.createCipheriv('aes-128-cbc', KEY, IV);
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('hex');
}
