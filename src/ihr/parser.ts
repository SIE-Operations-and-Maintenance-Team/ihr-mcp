// 报工条目。parseWorkEntry 仅能从 label 字符串解出前 4 个字段；
// listEntries 从条目接口结构化数据构造，会额外填 taskType/poId/tsTaskId（Task 5/6 消费）
export interface WorkEntry {
  projectCode: string;
  projectName: string;
  activityType: string;
  raw: string;
  taskType?: string; // 项目任务 | 部门任务（逆向结果 §1）
  poId?: string; // 项目/部门编号，地点接口入参
  tsTaskId?: string; // 工时任务 id，提交体携带
}

// 条目样例: SD26040155|方正微QMS二期质保-…·实施质保项目2026/项目执行
export function parseWorkEntry(raw: string): WorkEntry | null {
  const barIdx = raw.indexOf('|');
  if (barIdx < 0) return null;
  const projectCode = raw.slice(0, barIdx).trim();
  if (!projectCode) return null;
  let rest = raw.slice(barIdx + 1).trim();
  let activityType = '';
  const slashIdx = rest.lastIndexOf('/');
  if (slashIdx >= 0) {
    activityType = rest.slice(slashIdx + 1).trim();
    rest = rest.slice(0, slashIdx).trim();
  }
  return { projectCode, projectName: rest, activityType, raw };
}
