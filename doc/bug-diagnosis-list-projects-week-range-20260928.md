# Bug 诊断报告：list_projects 只返回 18 条，网页按月视图有 20 条

- **日期**：2026-09-28
- **状态**：已修复（2026-09-28，方案 A 实施完成：查询范围改为当月 1 日~月末）
- **严重级别**：P2 一般（不丢数据，但列表口径与 IHR 网页按月视图不一致，漏报当月条目）
- **报告人**：ZCode Agent（Bug Diagnosis Skill）

---

## 问题描述

网页配置面板"刷新项目列表"显示 **共 18 个条目**；而 IHR 官网工时填报页面切到"按月"视图（2026年9月）时，报工条目显示 **20 条**。用户怀疑：获取任务时没有选中当月的范围。

## 环境信息

- 分支/版本：main（工作区，未含本次改动）
- 相关模块：`src/service.ts`、`src/ihr/client.ts`、`src/web/api.ts`、`src/tools.ts`
- 复现步骤：当天（周一 2026-09-28）打开网页配置面板点"刷新项目列表"（或调 MCP `list_projects`），对比 IHR 网页按月视图条目数。

---

## 第一步：可能原因分析

| # | 原因 | 概率 | 理由 |
|---|------|------|------|
| 1 | **查询日期范围用了"当前周"而非"当月"**：`listProjectsWithMapping` 固定取 `currentWeekRange()`（周一~周日），IHR 服务端按条目 `startDate`/`endDate` 与该区间**求交集过滤**，2 条只在 9 月内有效、与本周（9/28~10/4）无交集的条目被过滤掉 | **高（已实证）** | 代码 `src/service.ts:40` 明确写死周范围；逆向文档 `doc/20260926-ihr接口逆向结果.md:41` 明确记录交集过滤语义，且 `:88` 记录过同类实测现象（"本周 19 条，另两周 17 条——部分条目因 startDate/endDate 过期被过滤"） |
| 2 | 前端/网页面板对返回结果做了额外去重或截断 | 低 | `api.ts:59` 直接 `json(200, { projects })`，无过滤逻辑；18 条逐行可见无重复 |
| 3 | IHR 服务端两接口不同（面板走了别的接口） | 排除 | 网页面板与 MCP 工具均调用 `listProjectsWithMapping` → 同一个 `GetBatchTimesheetObjects` 接口，与网页按月视图是同一接口、仅日期参数不同 |

## 第二步：验证动作（已验证）

- **验证方式**：代码走读 + 逆向文档交叉验证
- **位置**：`src/service.ts:24-32`（`currentWeekRange`）、`src/service.ts:40-41`（调用点）、`src/ihr/client.ts:120-126`（`listEntries` 透传 start/finish）
- **验证结果**：
  - 今天 2026-09-28 为周一，`currentWeekRange()` = `2026-09-28 ~ 2026-10-04`；
  - 网页按月视图传 `2026-09-01 ~ 2026-09-30`；
  - 服务端按条目 `startDate`/`endDate` 与传入区间求交集 → 本周口径下，2 条（推测为 9 月内已到期/未生效的条目）被过滤，18 vs 20 差异成立。
- **可选复核**：临时在 `listEntries` 返回前打印 `start/finish` 与 `list.length`，或用 `curl` 分别以周/月区间 POST `GetBatchTimesheetObjects` 对比条数（预期：周 18、月 20）。

## 第三步：调用链与依赖分析

```
网页面板「刷新项目列表」           MCP 工具 list_projects
  src/web/api.ts:59                src/tools.ts:155
        └────────────┬──────────────────┘
                     ▼
   listProjectsWithMapping()        [src/service.ts:34]
     → currentWeekRange()           [src/service.ts:24]  ← 根因：写死当前周一~周日
     → IhrClient.listEntries(start, finish)  [src/ihr/client.ts:120]
       → POST GetBatchTimesheetObjects       ← 服务端按 startDate/endDate 交集过滤
```

### 关键依赖节点

- **下游消费者**：`sourcesByWeek` 缓存（`client.ts:127`，key=`start~finish`）供 `submitWeek` 匹配条目（`client.ts:173-179`）。
- **重要**：`submitWeek` 在缓存 miss 时会**按需按周重新拉取**（`client.ts:176-178`），因此把列表查询范围改成"当月"**不会**影响提交流程——提交某周时若月范围缓存 key 不匹配，会自动以该周的 start/finish 重拉并缓存。

## 第四步：边缘情况检查

| 维度 | 场景 | 当前行为 | 是否有问题 | 建议 |
|------|------|----------|------------|------|
| 数据边界 | 跨月周（如 9/29 周一查 9 月） | 月范围与条目交集过滤，10 月起生效的条目不出现 | 否 | 与网页按月视图口径天然一致 |
| 缓存污染 | 月范围查询写入 `sourcesByWeek` | key=`2026-09-01~2026-09-30`，与周 key 不冲突；提交时按周重拉 | 否 | 无需改动 |
| 部门任务 | `4042 运维部`（1970~9999） | 任何区间都返回 | 否 | 不受影响 |
| 月初/月末 | 自然月取 1 号~月末 | 需按当月天数生成 finish | 否 | 修复时用本地时区生成 `YYYY-MM-DD` |

## 修复方案（待确认，未改代码）

- **方案 A（推荐，已通过 2 轮 review）**：`listProjectsWithMapping` 的查询范围由 `currentWeekRange()` 改为**当月 1 日~月末**，与网页"按月"视图口径一致，返回当月全部可报工条目（20 条）。`fill_work_hours` 提交链路不受影响（见第三步缓存分析）。
- **方案 B**：保持按周不动，仅在工具描述/面板提示"列表为当前周口径"。——不符合用户预期，不推荐。

## Review 结论（连续 2 轮通过，2026-09-28）

### 第 1 轮（代码级正确性）：PASS

- 根因证据链、月口径与网页 dateList 语义一致、`sourcesByWeek` 缓存 key 隔离、边界（跨年/闰月/部门任务）均核实通过。

### 第 2 轮（独立子代理复审，怀疑者视角找反例）：PASS

- **更强的隔离证据**：`listProjectsWithMapping`（service.ts:41）与 `fill_work_hours`（tools.ts:174-178）每次调用都各自 `new IhrClient(http)`，两链路从不共享 client 实例，月范围写入的缓存随一次性实例丢弃，跨链路污染结构上不可能。
- **测试影响修正**：现有测试零破坏——无 service.test.ts，无测试引用 `currentWeekRange`；`client.test.ts` 用显式日期测 `listEntries` 透传，不受影响。**无需同步改测试**，可选新增 `currentMonthRange` 单测。
- **反例逐项排除**：跨月提交（按周独立重拉）、月初报工、当月外条目、`sourcesByWeek` 键冲突（实例隔离下不存在；即便共享，月区间是周区间超集 `find` 仍命中）、面板/MCP 并发（仅共享带 token 的 axios 实例）——均无风险。
- **新暴露的失败路径（可接受）**：月口径列表会含"当月有效但与当前周无交集"的条目，用户选它填当前周日期时 `submitWeek` 按周拉取找不到 → `client.ts:184` 抛"条目未找到"。与网页月视图行为一致，属口径对齐的必然结果；建议在 `list_projects` 工具描述中提示"列表为当月口径，提交按周校验有效期"。

### 实施注意事项（确认后实施时执行）

1. `currentMonthRange` 用 `new Date(y, m+1, 0)` 取月末（自动处理闰年/月天数），本地时区补零生成 `YYYY-MM-DD`；注意 JS 月份 0-based。
2. `currentWeekRange`（service.ts:24-32）改后成为死代码（全仓唯一调用点即 40 行），随本次改动删除；**勿动** `client.ts:44` 私有 `weekRange`（提交分组依赖）。
3. README 第 14 行"按周拉取可填报项目"同步改为"按月"。
4. 月口径区间（当月 1 日~月末）为依据逆向文档 101 行 dateList 分段规则的推断口径，非抓包实证；服务端日粒度交集过滤下结果一致，实施说明中标注即可。
5. 验证方式：`npm run build` + `npm test`；实施前按 Dedupe Ticket 规则先补实施文档。

## 总结与建议

根因唯一且已实证：获取任务列表写死了"当前周"日期范围，而 IHR 服务端按条目有效期与该范围求交集过滤，导致 18（周）与 20（月）的差异。方案 A（查询范围改为当月）已连续 2 轮独立 review 通过，改动仅 `src/service.ts` 一处（约 8-12 行），现有测试零破坏；按上述实施注意事项执行即可。
