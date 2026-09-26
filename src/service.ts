import { readdirSync } from 'node:fs';
import { IhrClient } from './ihr/client.js';
import { WorkEntry } from './ihr/parser.js';
import { guessCustomer, MappingStore } from './mapping.js';
import { SessionManager } from './session.js';
import { Config } from './config.js';

export interface ProjectView extends WorkEntry {
  customer: string;
  customerSource: 'manual' | 'guess' | 'none';
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

// 当前周一~周日（填报周期口径，逆向结果 §2）
export function currentWeekRange(): { start: string; finish: string } {
  const d = new Date();
  const offset = (d.getDay() + 6) % 7; // 周一=0
  const monday = new Date(d); monday.setDate(d.getDate() - offset);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  const fmt = (x: Date) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return { start: fmt(monday), finish: fmt(sunday) };
}

export async function listProjectsWithMapping(deps: {
  cfg: Config;
  session: SessionManager;
  mapping: MappingStore;
}): Promise<ProjectView[]> {
  const http = await deps.session.getAuthedHttp();
  const { start, finish } = currentWeekRange();
  const entries = await new IhrClient(http).listEntries(start, finish);
  const folders = listLocalFolders(deps.cfg.projectsRoot);
  const manual = deps.mapping.load();
  return entries.map((e) => {
    if (manual[e.projectCode]) {
      return { ...e, customer: manual[e.projectCode], customerSource: 'manual' as const };
    }
    const guess = guessCustomer(e.projectName, folders);
    return {
      ...e,
      customer: guess ?? '未匹配',
      customerSource: guess ? ('guess' as const) : ('none' as const),
    };
  });
}
