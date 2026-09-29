# list_projects 暴露项目期望起止时间 实施计划

- 日期：2026-09-29（rev5 定稿：新一轮第 1 轮独立 review 通过；rev5 采纳 2 条 P3——service.ts 两分支追加说明、Web 管理页消费说明，不影响技术内容。此前 rev2~rev4 历经首轮 FAIL 修订 + 连续 2 轮 PASS）
- 目标：ihr-mcp 的 `list_projects` 工具返回中增加每个条目的**项目期望起止时间**（expectedStartDate/expectedEndDate），使 skill 排期时可以事前核对项目期，不再依赖"试提交探路"
- 状态：**待用户确认后执行代码修改**（TFS/git 仓库均不自动签入）

---

## 一、需求概述

9 月填报中，敏卓FCT（SD26090080）9/2~9/4 报工被拒："填报日期【2026-09-02】不在期望开始时间【2026-09-08】-项目期望完成日期【2026-10-31】范围内"。期望起止时间在提交失败前无任何途径获取（`list_projects` 不返回该字段），只能靠试提交探路。

抓包/源码确认：**数据源已存在**——`GetBatchTimesheetObjects` 每个条目自带 `startDate`/`endDate`（逆向结果 **§1** 响应示例 3 处；服务端按其与查询区间求交集过滤条目；提交时 detail 以 `{...src}` 展开 src 透传——逆向结果 §2，服务端据此校验填报日期（由报错消息 X/Y 与透传字段的对应关系推断，逆向文档未实证校验代码路径）），仅被 `client.ts listEntries` 的映射丢弃（src/ihr/client.ts:128-136）。

## 二、涉及文件

| 文件 | 变更 |
|------|------|
| `src/ihr/parser.ts`（**已存在**；调用方以 `./parser.js` 引用其编译产物，非新建/重命名） | `WorkEntry` 接口新增 `startDate?: string`、`endDate?: string` |
| `src/ihr/client.ts` | `listEntries` map 中补 `startDate: e.startDate`、`endDate: e.endDate` |
| `src/service.ts` | `listProjectsWithMapping` 条目追加 `expectedStartDate: e.startDate ?? null`、`expectedEndDate: e.endDate ?? null`（字段名与错误消息"期望开始时间/期望完成时间"对齐）。**注意 map 内有两个 return 分支（manual 命中分支与 guess 分支），两处均需追加**；建议将 expected* 声明为 `ProjectView` 必需字段，由 tsc 强制两分支兜底 |
| `test/ihr/client.test.ts` | `listEntries` 用例的 `toMatchObject` 断言补 `startDate: '2026-04-01'`、`endDate: '2027-03-31'`（mock SOURCES 已含该字段） |
| `test/service.test.ts`（可选） | 补一条 expected* 透传断言（现有用例仅断言请求体，不加也不破坏） |
| `skill/ihr-attendance/SKILL.md` | **7.1 判读表第 5 行**（"填报日期不在期望开始时间【X】-期望完成日期【Y】范围内"）处置改为"排期时直接读 list_projects 的 expectedStartDate/expectedEndDate 核对"，删去"期望起止时间无 MCP 数据源…试提交探路"表述；**§5.1 排期式填报**补充"排期前读该字段核对项目期" |
| `src/tools.ts` | `list_projects` 的 MCP 工具 description 补"项目期望起止时间"（agent 侧感知字段的主要入口） |
| `README.md` | 工具表中 `list_projects` 输出字段补 expectedStartDate/expectedEndDate（沿用 cf79bb5 同步 README 的惯例） |

## 三、实施步骤

1. `parser.ts`：`WorkEntry` 增加 `startDate?: string`、`endDate?: string`（可选字段，兼容既有调用）
2. `client.ts` `listEntries`：map 中补 `startDate: e.startDate, endDate: e.endDate`
3. `service.ts`：`listProjectsWithMapping` 条目追加 `expectedStartDate: e.startDate ?? null`、`expectedEndDate: e.endDate ?? null`（manual/guess 两个 return 分支均需追加，见 §二）
4. 测试：`client.test.ts` listEntries 断言补两字段；（可选）`service.test.ts` 补透传断言
5. 编译与测试：`npm run build`、`npm test` 均通过
6. 发布与重启：按仓库既有 publish 流程（用户执行或明确指示后执行），重启 ihr-mcp
7. 端到端验证：调用 `list_projects`，确认敏卓FCT（SD26090080）条目输出 `expectedStartDate=2026-09-08`、`expectedEndDate=2026-10-31`；抽查其他条目（如海创 2026 年区间）合理
8. 同步 skill：更新 `skill/ihr-attendance/SKILL.md` 7.1 判读表第 5 行 + §5.1，同步 `.zcode`/`.agents` 副本
9. git commit（人工确认注释后执行或由用户操作）。**注意**：工作区尚有"默认交付类型/两段式"等在途未提交改动，与本方案共同触及 `client.ts`/`SKILL.md`/测试文件，需先将其单独签入或经用户确认后合并提交，勿混提

## 四、注意事项

- **条目随查询区间过滤（当月口径）**：`list_projects` 固定按当月 1 日~月末查询（`service.ts currentMonthRange`，commit 5d668d4 起）；服务端按条目 startDate/endDate 与查询区间求交集返回，项目期与当月无交集的条目不出现（即"当月不可见=当月不在其项目期"）。**已知限制**：跨月排期（如 9 月底排 10 月）时，项目期仅覆盖下月的条目当月查询不可见，只能等次月查询或试提交验证。敏卓FCT（9/8~10/31）与 9 月有交集，当月查询可见、字段有值
- **输出字段重复说明**：`WorkEntry` 增加 startDate/endDate 后，`service.ts` `{...e}` 展开会把原始名 startDate/endDate 一并带入 `list_projects` 输出，与 expectedStartDate/expectedEndDate 并存（值相同）。为最小改动不做剥离，消费方（skill）以 expected* 为准；如日后需仅保留 expected*，可在输出层显式置 undefined（JSON 序列化省略），本次不做。Web 管理页 `/api/projects`（src/web/api.ts）同样整体透传该输出，前端页面仅读既有 projectCode/projectName/activityType 字段，无需改动
- 字段命名 `expectedStartDate/expectedEndDate` 仅用于 MCP 输出层，不改内部 `startDate/endDate`（与服务端 DTO 对齐）
- `doc/` 下本文档按近期惯例不入 git（20260929 的 doc 均未跟踪；早期 8 份——20260926-*.md 3 份、20260928-publish-*.md 2 份、20260928-失败报错实施计划 1 份、bug-diagnosis-*-20260928 2 份——已被跟踪）——如需签入请指出
- 不自动 commit；编译/发布/重启由用户确认

## 五、已读取规范

- 本仓库无 CLAUDE.md/.claude/rules/rule/rules 规范来源（已检查），非 SMOM 项目，按 AGENTS.md 通用约束执行：先文档后代码、编译+测试验证、不自动签入

## 六、注意事项（遗留）

- 本次仅暴露字段；"阶梯取整/排期算法"使用该字段的逻辑在 skill 侧完成，不在本仓库实现
