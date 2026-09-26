import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { configDir } from './config.js';

// 客户推断：本地客户文件夹名出现在项目名称中即命中，多个命中取最长
export function guessCustomer(projectName: string, localFolders: string[]): string | null {
  let best: string | null = null;
  for (const f of localFolders) {
    if (f && projectName.includes(f) && (best === null || f.length > best.length)) {
      best = f;
    }
  }
  return best;
}

export class MappingStore {
  constructor(private filePath: string = join(configDir(), 'mapping.json')) {}

  load(): Record<string, string> {
    if (!existsSync(this.filePath)) return {};
    return JSON.parse(readFileSync(this.filePath, 'utf8'));
  }

  private persist(m: Record<string, string>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(m, null, 2), 'utf8');
  }

  get(projectCode: string): string | undefined {
    return this.load()[projectCode];
  }

  set(projectCode: string, customer: string): void {
    const m = this.load();
    m[projectCode] = customer;
    this.persist(m);
  }
}
