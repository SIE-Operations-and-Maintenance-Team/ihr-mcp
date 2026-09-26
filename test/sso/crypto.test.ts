import { describe, it, expect } from 'vitest';
import { encryptPassword } from '../../src/sso/crypto.js';

describe('encryptPassword（与 SSO 前端 umi.js 加密保持一致）', () => {
  it('加密纯字母', () => {
    expect(encryptPassword('hello')).toBe('a227bf6a986467f54643f5392109ba2b');
  });
  it('加密含特殊字符的密码', () => {
    expect(encryptPassword('Test@123456')).toBe('38c86f4bd3632097ad26a360796418b0');
  });
  it('加密中文（UTF-8 多字节）', () => {
    expect(encryptPassword('中a密1')).toBe('3c76fb419459ca54610d530acf4d0acb');
  });
});
