import { readdirSync } from 'node:fs';
import { IhrClient } from './ihr/client.js';
import { WorkEntry } from './ihr/parser.js';
import { guessCustomer, MappingStore } from './mapping.js';
import { SessionManager } from './session.js';
import { Config } from './config.js';

export interface ProjectView extends WorkEntry {
  customer: string;
  customerSource: 'manual' | 'guess' | 'none';
  expectedStartDate: string | null; // 项目期望起止时间（条目 startDate/endDate 透传，缺省 null）
  expectedEndDate: string | null;
}

export function listLocalFolders(projectsRoot: string): string[] {
  try {
    return readdirSync(projectsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

// 当月 1 日~月末：服务端按条目 startDate/endDate 与该区间求交集过滤（逆向结果 §1），
// 周区间会漏掉"当月有效但与当前周无交集"的条目，故对齐网页"按月"视图口径
export function currentMonthRange(): { start: string; finish: string } {
  const d = new Date();
  const fmt = (x: Date) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return { start: fmt(new Date(d.getFullYear(), d.getMonth(), 1)), finish: fmt(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
}

export async function listProjectsWithMapping(deps: {
  cfg: Config;
  session: SessionManager;
  mapping: MappingStore;
}): Promise<ProjectView[]> {
  const http = await deps.session.getAuthedHttp();
  const { start, finish } = currentMonthRange();
  const entries = await new IhrClient(http).listEntries(start, finish);
  const folders = listLocalFolders(deps.cfg.projectsRoot);
  const manual = deps.mapping.load();
  return entries.map((e) => {
    if (manual[e.projectCode]) {
      return { ...e, customer: manual[e.projectCode], customerSource: 'manual' as const, expectedStartDate: e.startDate ?? null, expectedEndDate: e.endDate ?? null };
    }
    const guess = guessCustomer(e.projectName, folders);
    return {
      ...e,
      customer: guess ?? '未匹配',
      customerSource: guess ? ('guess' as const) : ('none' as const),
      expectedStartDate: e.startDate ?? null,
      expectedEndDate: e.endDate ?? null,
    };
  });
}
