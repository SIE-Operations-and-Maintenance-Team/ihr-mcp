import { describe, it, expect } from 'vitest';
import { withReauth } from '../src/tools.js';

describe('withReauth', () => {
  it('errorCode=401 时 invalidate 并重登重试一次', async () => {
    let invalidated = 0;
    const deps = { session: { invalidate: () => invalidated++ } } as any;
    let calls = 0;
    const result = await withReauth(deps, async () => {
      calls++;
      if (calls === 1) throw new Error('ihr 接口失败 [errorCode=401]: 系统未登录或认证已过期');
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(calls).toBe(2);
    expect(invalidated).toBe(1);
  });
  it('其他错误原样抛出，不 invalidate', async () => {
    let invalidated = 0;
    const deps = { session: { invalidate: () => invalidated++ } } as any;
    await expect(
      withReauth(deps, async () => {
        throw new Error('条目未找到: X|Y');
      }),
    ).rejects.toThrow('条目未找到: X|Y');
    expect(invalidated).toBe(0);
  });
});
