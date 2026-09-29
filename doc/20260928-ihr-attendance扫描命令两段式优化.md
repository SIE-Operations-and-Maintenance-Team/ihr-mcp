# ihr-attendance skill 扫描命令两段式优化

- 日期：2026-09-28
- 类型：skill 命令优化（非项目代码改动）
- 状态：待确认（review 达成连续 2 次通过：第 3、4 轮独立评审均通过；第 1、2 轮发现实质问题已修订）

## 背景

`ihr-attendance` SKILL.md 第 3 步"扫描工作文档"使用 `find "<P>" -path "*/doc/*" ...` 全树遍历。`projectsRoot`（`F:\项目`）下共有 **203 万个文件**（含 node_modules、.git 等），逐个 stat + 模式匹配导致单次扫描约 **87~100 秒**。

方案：先在浅层定位所有 doc 目录，再在各 doc 目录内递归查 md 文件（两段式）。

## 实测数据（2026-09-28，热缓存，口径均为 `202609*` 月度）

| 方案 | 耗时 | 9月文件数 | 备注 |
|------|------|-----------|------|
| 原命令（全树 find） | 86.9s~100s | **151** | 其中 5 个为敏卓基线快照（见排除项），无 node_modules 噪声 |
| find + prune 剪枝 | 60s | 151 | 结果同上，但仍需遍历大半棵树 |
| rg --files（并行） | 23s | 145（单次采样） | 结果受 .gitignore 影响不稳定（复测 30~400+ 波动），不作为选型依据 |
| **两段式 maxdepth 4（选定）** | **3.8s~4.2s** | **146** | 第一段 1.2s 定位 18 个 doc 目录 |
| 单段 maxdepth 6 + -path | 18.4s | 146 | `-path` 无法阻止进入 node_modules，慢约 5 倍 |

> 口径勘误：早期测试曾得出"原命令 436 个、含 285 个垃圾匹配"，实为 `2026*` 全年口径与 `202609*` 月度口径混用所致；月度口径复跑为 151 个、0 个 node_modules 噪声。新命令 146 = 旧命令 151 − 有意排除的基线快照 5。

## 深度档位实测（第一段 find 耗时 / 目录构成）

| maxdepth | 耗时 | doc 目录数 | 构成 |
|----------|------|-----------|------|
| 3 | 0.4s | 16 | 深度≤3 的全部真实 doc，**但漏 2 个深度 4 的真实项目 doc** |
| **4（选定）** | **1.2s** | **18** | 16 + `富士达/H5/elec8.3_mes/doc` + `新容/H5/MES/doc`，无任何噪声 |
| 5 | 4.5s | 21 | +3 个 `杰科/*/node_modules/{nan,readable-stream}/doc` 纯噪声 |

深度 4 漏扫的实证（maxdepth 3 的代价）：7 月口径（`202607*`）maxdepth 3 得 90 个、maxdepth 4 得 **91 个**，差值即 `富士达/H5/elec8.3_mes/doc/设计实施文档/20260717-项目初始化实施计划.md`；新容 H5 的 `bug-diagnosis-package-duplicate-boxes-20260605.md` 同理会在 6 月口径漏掉。maxdepth 4 时 node_modules 的 doc 全在深度 5+，天然排除，无需 prune。

## 大小写问题（bash 与 PowerShell 行为对齐）

`F:\项目` 下另有 **10 个大写 `Doc` 目录**（深度 4，如 `埃泰克/H5/QMS/Doc`、`富士达/H5/elec8.3_qms/Doc`），内容均为 QMS 接口说明副本（`QMS接口说明.md` 等），无日期命名工作文档。

- GNU find 的 `-name doc` **区分大小写**：天然排除这 10 个目录，18 个结果全为真实工作文档目录
- PowerShell 的 `-Filter doc` **不区分大小写**：会多带入这 10 个目录（28 个），必须加 `Where-Object { $_.Name -ceq 'doc' }` 与 bash 对齐

层级对应关系（已实测）：PowerShell `-Depth N` ≡ find `-maxdepth N+1`（`-Depth 3` ≡ `-maxdepth 4`）。

## 改动内容

修改 SKILL.md 第 3 步"扫描工作文档"，共 4 处。文件共 4 份副本（内容当前逐字一致）：

**skill 分发链**（发布时 `skill/` → 发布包 → 用户安装到 agent 技能目录）：

- `F:\GitHubs\ihr-mcp\skill\ihr-attendance\SKILL.md`（git 管理的源，修改后不签入，等人工确认）
- `F:\GitHubs\ihr-mcp\publish\ihr-mcp-v0.1.0\skill\ihr-attendance\SKILL.md`（当前部署包，gitignore 不入库，就地部署目录）
- `C:\Users\11013\.zcode\skills\ihr-attendance\SKILL.md`（本机已安装）
- `C:\Users\11013\.agents\skills\ihr-attendance\SKILL.md`（本机已安装）

### 1. Git Bash 主查命令（原第 39-41 行）

旧：

```bash
find "<P>" -path "*/doc/*" -type f \( -name "202609*.md" -o -name "*-202609*.md" \)
```

新（两段式：先浅层定位 doc 目录，再在 doc 内递归；不吞 stderr，`<P>` 路径错误时保留报错，避免误判"当月无文档"；`-name doc` 大小写敏感，天然排除大写 `Doc` 接口文档目录与深度 5+ 的 node_modules doc）：

```bash
find "<P>" -maxdepth 4 -type d -name doc | while read -r d; do
  find "$d" -type f \( -name "202609*.md" -o -name "*-202609*.md" \)
done
```

### 2. PowerShell 主查命令（原第 45-47 行）

旧：

```powershell
Get-ChildItem "<P>" -Recurse -File -Filter *.md | Where-Object { $_.FullName -match '\\doc\\' -and $_.Name -match '^(202609\d\d-.*|.*-202609\d\d)\.md$' } | ForEach-Object FullName
```

新（`-Depth 3` ≡ find `-maxdepth 4`；`-ceq` 剔除大小写不敏感多带入的大写 `Doc` 接口文档目录，与 bash 版对齐）：

```powershell
Get-ChildItem "<P>" -Depth 3 -Directory -Filter doc | Where-Object { $_.Name -ceq 'doc' } | ForEach-Object { Get-ChildItem $_.FullName -Recurse -File -Filter *.md } | Where-Object { $_.Name -match '^(202609\d\d-.*|.*-202609\d\d)\.md$' } | ForEach-Object FullName
```

### 3. mtime 兜底补扫命令（原第 51-53 行）

旧：

```bash
find "<P>" -path "*/doc/*" -name "*.md" -type f -newermt 2026-09-01 ! -newermt 2026-10-01
```

新（同样两段式，否则仍是全树遍历；仅 bash 版，与原状一致）：

```bash
find "<P>" -maxdepth 4 -type d -name doc | while read -r d; do
  find "$d" -type f -name "*.md" -newermt 2026-09-01 ! -newermt 2026-10-01
done
```

### 4. 第 3 步末尾（mtime 补扫代码块之后、"逐个读取文件标题…"句之前）插入结构说明

> 工作文档位于 projectsRoot 深度 ≤4 的 `doc` 目录内（doc 内部子目录不限深度），实际结构如 `<P>/doc`、`<P>/方正微/doc`、`<P>/海创/C#/doc`、`<P>/富士达/H5/elec8.3_mes/doc`。命令有意排除：更深层的 doc（如 `.superpowers` 历史基线快照）与大写 `Doc` 接口文档目录。若未来 doc 放置层级加深，把 `-maxdepth 4`（PowerShell 为 `-Depth 3`）调大一档。

## 有意排除项登记

| 目录 | 深度 | 内容 | 排除方式 |
|------|------|------|---------|
| `敏卓/SMOM.EIS.Minzh/.superpowers/sdd/*/baseline/doc` | 7 | AI 实施计划历史基线快照，9 月 5 个文件 | maxdepth 4 截断 |
| `华俊/C#/.superpowers/sdd/snapshots/*/doc` | 7 | 任务快照 doc，202607 口径 4 个文件 | maxdepth 4 截断 |
| `*/H5/QMS/Doc` 等 10 个大写 Doc | 4 | QMS 接口说明副本，无日期文档 | find 大小写敏感 / PS `-ceq` |

## 已知限制（预存在，本方案不修，仅登记）

- **填报文档自引用**：`<P>/doc/20260928-考勤填报-2026年9月.md` 命中 `202609*.md`，下月扫描会把上月填报文档读入归纳（新旧行为相同）
- **日期带横杠命名不命中**：如 `中恒MES/SMOM.EIS.Zhongheng_Prod/doc/2026-05-29-工单作业统计待确认数实时获取.md`，前缀/后缀两种模式均不匹配，靠 mtime 补扫兜底
- **bash 通配与 PS 正则微差**：bash `202609*.md` 可匹配无连缀的 `202609.md`，PS 正则要求 `\d\d-`；当前树内无此差异实例
- **mtime 补扫无 PowerShell 版本**：原有设计，维持不变

## 验证方式

1. 改后 `diff` 两处 SKILL.md，保持逐字一致
2. Git Bash 主查扫 2026 年 9 月 → **146**；扫 2026 年 7 月 → **91**（含 `富士达/H5/elec8.3_mes/doc/设计实施文档/20260717-项目初始化实施计划.md`，证明深度 4 覆盖）
3. PowerShell 主查扫 9 月 → **146**，第一段目录数（加 `-ceq` 后）→ **18**
4. mtime 补扫（两段式）9 月 → **187**
5. 对账基准：新命令 146 = 旧命令 151 − 有意排除的敏卓基线 5

## review 修订记录

- 第 1 轮（作者自查）：移除两段式命令中的 `2>/dev/null`——路径错误静默变空结果会让 agent 误判"当月无工作文档"，须保留报错。**不通过→已修**
- 第 2 轮（两名独立评审）：① maxdepth 3 会漏 2 个深度 4 的真实项目 doc（富士达/H5/elec8.3_mes、新容/H5/MES，7 月口径实证漏 1 个）→ 选型改 **maxdepth 4**；② "原命令 436/285 垃圾"系全年与月度口径混用，修正为 151/0 噪声；③ rg 数据不稳定，标注不作选型依据；④ 结构示例"客户/项目"为虚构层级，改为真实路径；⑤ 发现 bash/PS 大小写行为分叉（10 个大写 Doc 目录），PS 加 `-ceq` 对齐；⑥ 排除项补登华俊 snapshots；⑦ 验证步骤补 PS 与 mtime 复验及 7 月口径。**不通过→已修（本文档为第 2 版）**
- 第 3 轮（独立评审）：前两轮 7 项修正全部核验落实，关键数字（18/146/91/187、PS 18+146、对账 146=151−5）独立复跑全部命中，判定**通过**；随附 2 个 P2 文字瑕疵（富士达 7 月文件路径少写 `设计实施文档/` 一层、"慢 6 倍"实为约 5 倍）已顺手修正，进入第 4 轮确认。
- 第 4 轮（独立评审，最终复核）：通过，无问题。方案 review 结束（连续 2 次通过达成）。
- 执行后补记（2026-09-28，用户指正）：实施与评审均遗漏了分发链上游的 2 份副本——`skill/ihr-attendance/SKILL.md`（git 管理的源）与 `publish/ihr-mcp-v0.1.0/skill/ihr-attendance/SKILL.md`（当前部署包）。二者当时均与旧版逐字一致，本次以新版 .zcode 副本覆盖补齐，4 份副本保持逐字一致。
