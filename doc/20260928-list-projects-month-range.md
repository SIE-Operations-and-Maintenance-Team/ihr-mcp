# list_projects 查询范围改为当月 实施计划

> **For agentic workers:** 按本计划逐任务实施。步骤使用 checkbox（`- [ ]`）语法跟踪。
> **执行前置条件（用户全局规则）**：本实施文档经用户确认后才能开始改代码；编译通过 + 测试全绿才算修改完成；提交/签入必须等用户人工确认，不得自动执行。

**Goal:** 把 `list_projects` 获取报工条目的查询范围从"当前周一~周日"改为"当月 1 日~月末"，对齐 IHR 网页"按月"视图口径，消除 18 条 vs 20 条的差异。

**Architecture:** 根因在 `src/service.ts` 的 `listProjectsWithMapping` 写死 `currentWeekRange()`；IHR 服务端按条目 `startDate`/`endDate` 与查询区间求交集过滤，周区间漏掉"当月有效但与当前周无交集"的条目。修复 = 原位替换为新的 `currentMonthRange` 纯函数；提交链路（`fill_work_hours`）按周独立拉取缓存，结构上不受影响（两链路各自 `new IhrClient`，从不共享实例）。

**Tech Stack:** Node.js ≥20 ESM、TypeScript（tsc 编译）、vitest、axios（测试内自定义 adapter mock）。

**Spec:** `doc/bug-diagnosis-list-projects-week-range-20260928.md`（诊断报告，已通过 2 轮 review；本计划实施其"方案 A"与"实施注意事项"）。

## Global Constraints

- 注释/文案统一中文，风格与现有代码一致（含"（逆向结果 §N）"出处标注习惯）。
- **禁改** `src/ihr/client.ts` 私有 `weekRange`（`client.ts:44`，提交分组依赖）。
- 月口径（当月 1 日~月末）为推断口径（依据逆向文档 §"填报周期口径"的 dateList 分段规则），非抓包实证；服务端日粒度交集过滤下结果一致，在代码注释中标注口径来源即可，不需要额外验证。
- 每个任务收口门槛：`npm run build`（tsc + copy-assets）零错误 + `npm test`（vitest run）全绿。
- 工作区已有无关本地改动（`M scripts/publish.mjs`）：提交步骤只 `git add` 本计划明确列出的文件，不得使用 `git add -A`/`git add .`。
- 提交信息风格沿用仓库惯例（中文、`fix:`/`docs:` 前缀）。

## Dedupe Ticket（新增函数前出具）

- **Intent signature**: 新增纯函数，返回"当月 1 日~当月月末"的 `{start, finish}` 日期区间（本地时区，`YYYY-MM-DD`）。
- **Queries**: `grep currentWeekRange`、`grep weekRange`、`grep "start.*finish"`（src/ + test/）。
- **Top matches**: `src/service.ts:24`（`currentWeekRange`，唯一调用点在本文件 40 行）、`src/ihr/client.ts:44`（私有 `weekRange`：日期→所在周，提交分组用）、`src/config.ts`（无日期逻辑）。
- **Decision**: `extend` —— 在 `src/service.ts` 原位扩展：新增 `currentMonthRange` 替换并删除 `currentWeekRange`。
- **Rationale**: 唯一调用点就在本文件；`client.ts` 的 `weekRange` 语义是"任一日期→所在周区间"，与"当前月区间"不同且属提交链路，不复用、不合并。

## 文件结构

| 文件 | 操作 | 职责 |
|---|---|---|
| `src/service.ts` | 修改（23-32、40 行） | 新增 `currentMonthRange`，删除 `currentWeekRange`（连同其注释），替换调用点 |
| `test/service.test.ts` | 新建 | `currentMonthRange` 单测 + `listProjectsWithMapping` 发送月区间的回归测试 |
| `src/tools.ts` | 修改（82 行） | `list_projects` 工具描述补"当月口径"提示 |
| `README.md` | 修改（14、97 行） | "按周拉取"→"按当月拉取"；"当前周可填报项目"→"当月可填报项目" |
| `doc/bug-diagnosis-list-projects-week-range-20260928.md` | 修改 | 实施完成后状态改"已修复" |

---

### Task 1: 核心修复——service.ts 查询范围改为当月

**Files:**
- Modify: `src/service.ts:24-32`（删 `currentWeekRange`）、`src/service.ts:40`（替换调用）
- Create: `test/service.test.ts`

**Interfaces:**
- Consumes: 无（本任务自包含）。
- Produces: `export function currentMonthRange(): { start: string; finish: string }`（本地时区，`start`=当月 1 日，`finish`=当月月末，格式 `YYYY-MM-DD`）；**删除** `currentWeekRange` 导出。`listProjectsWithMapping` 签名与返回类型不变（后续任务/调用方无感）。

- [ ] **Step 1: 写失败测试**

新建 `test/service.test.ts`，内容完整如下（mock http 的 `makeHttp` 从 `test/ihr/client.test.ts:8-18` 复制同款；`getAuthedHttp` 用假 session 注入，参照 `test/tools.test.ts:15` 的 `as any` 模式）：

```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { currentMonthRange, listProjectsWithMapping } from '../src/service.js';
import { MappingStore } from '../src/mapping.js';
import { IHR_LIST_ENTRIES_PATH, IHR_USER_INFO_PATH, IHR_STAFF_HEADER_PATH } from '../src/ihr/client.js';

afterEach(() => vi.useRealTimers());

// mock：按 path 路由并记录调用（HTTP 恒 200，业务错误走 errorCode，见逆向结果 §0）
function makeHttp(routes: Record<string, unknown>, calls: Array<{ path: string; body: any }> = []) {
  return axios.create({
    adapter: (async (config: any) => {
      const path = String(config.url);
      calls.push({ path, body: config.data ? JSON.parse(config.data) : undefined });
      const route = routes[path];
      if (route === undefined) throw new Error(`测试未配置路由: ${path}`);
      return { data: route, status: 200, statusText: 'OK', headers: {}, config };
    }) as any,
  });
}

describe('currentMonthRange', () => {
  it('普通月（30 天）：当月 1 日 ~ 月末', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T10:00:00'));
    expect(currentMonthRange()).toEqual({ start: '2026-09-01', finish: '2026-09-30' });
  });

  it('闰年 2 月：finish 为 02-29', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2028-02-10T10:00:00'));
    expect(currentMonthRange()).toEqual({ start: '2028-02-01', finish: '2028-02-29' });
  });

  it('31 天大月，月末当天调用也不越界', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-31T23:00:00'));
    expect(currentMonthRange()).toEqual({ start: '2026-01-01', finish: '2026-01-31' });
  });
});

describe('listProjectsWithMapping（回归：修复前发的是当前周区间）', () => {
  it('按当月区间请求条目', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T10:00:00')); // 修复前该周为 2026-09-14~2026-09-20
    const calls: Array<{ path: string; body: any }> = [];
    const http = makeHttp({
      [IHR_USER_INFO_PATH]: { errorCode: '0', data: { staffId: 27710, staffName: '<姓名>' } },
      [`${IHR_STAFF_HEADER_PATH}?staffId=27710`]: { errorCode: '0', data: { deptCode: '4042', deptName: '运维部' } },
      [IHR_LIST_ENTRIES_PATH]: { errorCode: '0', data: [] },
    }, calls);
    const deps = {
      cfg: { username: 'u', password: 'p', port: 13210, host: '127.0.0.1', projectsRoot: 'F:\\不存在的目录', configOk: true },
      session: { getAuthedHttp: async () => http },
      mapping: new MappingStore(join(mkdtempSync(join(tmpdir(), 'ihr-mcp-')), 'mapping.json')),
    } as any;
    await listProjectsWithMapping(deps);
    const post = calls.find((c) => c.path === IHR_LIST_ENTRIES_PATH);
    expect(post?.body).toEqual({ userId: '27710', start: '2026-09-01', finish: '2026-09-30' });
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npm test -- test/service.test.ts`
Expected: FAIL —— `currentMonthRange` 未导出（import 报错或 "is not a function"）；回归测试若先绕过 import 问题则断言 body 为周区间而失败。

- [ ] **Step 3: 最小实现**

`src/service.ts` 中删除 23-32 行的 `currentWeekRange` 及其注释，原位替换为：

```typescript
// 当月 1 日~月末：服务端按条目 startDate/endDate 与该区间求交集过滤（逆向结果 §1），
// 周区间会漏掉"当月有效但与当前周无交集"的条目，故对齐网页"按月"视图口径
export function currentMonthRange(): { start: string; finish: string } {
  const d = new Date();
  const fmt = (x: Date) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return { start: fmt(new Date(d.getFullYear(), d.getMonth(), 1)), finish: fmt(new Date(d.getFullYear(), d.getMonth() + 1, 0)) };
}
```

并将 40 行调用点 `const { start, finish } = currentWeekRange();` 改为 `const { start, finish } = currentMonthRange();`。

（说明：`new Date(y, m+1, 0)` 的 day=0 回退到上月最后一天，自动处理闰年与大小月；月份为 0-based。）

- [ ] **Step 4: 运行测试，确认通过**

Run: `npm test -- test/service.test.ts`
Expected: PASS，4 个用例全绿。

- [ ] **Step 5: 全量收口**

Run: `npm run build && npm test`
Expected: tsc 零错误，copy-assets 正常，全部测试通过（现有测试不引用 `currentWeekRange`，零破坏）。

- [ ] **Step 6: 提交【需用户人工确认后才执行】**

```bash
git add src/service.ts test/service.test.ts
git commit -m "fix: list_projects 查询范围由当前周改为当月，对齐 IHR 网页按月口径"
```

---

### Task 2: 工具描述与文档口径同步

**Files:**
- Modify: `src/tools.ts:82`
- Modify: `README.md:14、97`
- Modify: `doc/bug-diagnosis-list-projects-week-range-20260928.md`（状态行）

**Interfaces:**
- Consumes: Task 1 的 `currentMonthRange` 行为（月口径已生效）。
- Produces: 无代码接口变化，仅 MCP 工具 `list_projects` 的 description 文案与 README 描述更新。

- [ ] **Step 1: 更新 tools.ts 工具描述**

`src/tools.ts:82` 原文：

```typescript
        description: '获取 ihr 报工项目条目列表（项目编号/名称/活动类型/客户映射）',
```

改为（提示月口径 + 提交按周校验，避免用户选了"当月有效但当前周无效"的条目提交时报"条目未找到"却无预期）：

```typescript
        description: '获取 ihr 报工项目条目列表（当月口径；项目编号/名称/活动类型/客户映射。提交时按填报周校验条目有效期）',
```

- [ ] **Step 2: 更新 README 口径描述（两处）**

`README.md:14` 原文：

```markdown
- **报工条目获取**：按周拉取可填报项目，解析项目编号/名称/活动类型，自动推断项目归属客户（可手动修正）
```

改为：

```markdown
- **报工条目获取**：按当月拉取可填报项目，解析项目编号/名称/活动类型，自动推断项目归属客户（可手动修正）
```

`README.md:97`（MCP 工具表，review 第 2 轮补充发现的遗漏口径）原文：

```markdown
| `list_projects` | 无 | 当前周可填报项目：`{projectCode, projectName, activityType, customer, customerSource, ...}` |
```

改为：

```markdown
| `list_projects` | 无 | 当月可填报项目：`{projectCode, projectName, activityType, customer, customerSource, ...}` |
```

- [ ] **Step 3: 更新诊断报告状态**

`doc/bug-diagnosis-list-projects-week-range-20260928.md` 头部状态行当前原文：

```markdown
- **状态**：已确认；方案 A 已通过连续 2 轮独立 review（2026-09-28），待用户确认后实施
```

改为：

```markdown
- **状态**：已修复（2026-09-28，方案 A 实施完成：查询范围改为当月 1 日~月末）
```

- [ ] **Step 4: 全量收口**

Run: `npm run build && npm test`
Expected: 全绿（README/doc 不参与编译，此步保证 tools.ts 文案改动无语法破坏）。

- [ ] **Step 5: 提交【需用户人工确认后才执行】**

```bash
git add src/tools.ts README.md doc/bug-diagnosis-list-projects-week-range-20260928.md
git commit -m "docs: list_projects 描述与 README 同步当月口径，诊断报告置为已修复"
```

---

## 验收标准（对照诊断报告）

1. `npm run build && npm test` 全绿。
2. `test/service.test.ts` 回归用例锁死"月区间请求体"（`start=当月1日, finish=月末`），再回归会立即失败。
3. 重新运行 `list_projects`（面板"刷新项目列表"或 MCP 调用），预期返回 20 条（与 IHR 网页按月视图一致）；此步需真实环境，属用户验收项，不在本计划内自动执行。
4. `currentWeekRange` 已删除；`src/ihr/client.ts` 零改动（`git diff` 确认）。

---

## Review 结论（连续 2 轮通过，2026-09-28）

### 第 1 轮（计划逐项正确性审查）：PASS

- vitest include（`test/**/*.test.ts`）与 tsconfig（只编译 `src`）确认新测试文件会被执行且不进 tsc；mock 路由键与 `client.ts` 实际请求拼接一致；日期数学逐项核算无误（2026-09-15 为周二，修复前周区间 2026-09-14~09-20）；`tools.ts:82`、`README.md:14` 原文逐字核对一致。

### 第 2 轮（独立子代理怀疑者复审）：PASS

- **精确字符串**：全部 import 符号与 mock 路由逐项对照真实代码一致；"修复前预期失败"的两种失败形态（缺名导入 + 断言失败）均成立。
- **可执行性深挖**：核实到 vitest 3.2.7 源码的 win32 filter 分支，`npm test -- test/service.test.ts` 文件过滤在 Windows 下有效；fake timers 默认不 fake 微任务，async/axios adapter 不受影响；`listLocalFolders` 对不存在目录 ENOENT→`[]`，`MappingStore.load()` 对 temp 路径返回 `{}`，回归用例无"测试未配置路由"风险。
- **提交隔离**：`git status` 实测确认逐文件 `git add` 白名单不会卷入 `M scripts/publish.mjs` 等无关改动。
- **遗漏排查**：`src/web/public/index.html` 与 `skill/ihr-attendance/SKILL.md` 均无周口径文案，不需改。
- **发现并已修正的两处计划缺陷**（随本节同步进上文任务步骤）：
  1. `README.md:97`（MCP 工具表）"当前周可填报项目"漏改——已补进 Task 2 Step 2；
  2. 文件结构表行号 24-32 与 Step 3 的 23-32 不一致（23 行是 `currentWeekRange` 的注释）——已统一为 23-32，避免残留过时注释。


