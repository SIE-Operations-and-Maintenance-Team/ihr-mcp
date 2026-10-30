# skill 目录改名为 skills（兼容 cc-switch 识别）

- 日期：2026-10-30
- 背景：仓库根目录的 skill 源目录名为 `skill/`，cc-switch 只识别 `skills/`，导致无法从本仓加载填报考勤 skill。

## 目标

将仓库内 skill 源目录 `skill/` 重命名为 `skills/`，并同步所有受影响的路径引用，保持发布链路与测试可用。

## 改动清单

| 序号 | 文件 | 改动 |
|------|------|------|
| 1 | `skill/ihr-attendance/` → `skills/ihr-attendance/` | 目录重命名（`git mv` 保留历史） |
| 2 | `scripts/publish.mjs:41` | 打包拷贝源/目标目录 `skill` → `skills` |
| 3 | `scripts/publish.mjs:79` | 提示文案 `skill/ihr-attendance` → `skills/ihr-attendance` |
| 4 | `test/publish.test.ts:30` | 测试夹具路径 `skill/example.txt` → `skills/example.txt` |
| 5 | `README.md:9,143,225` | 文档路径引用 `skill/ihr-attendance` → `skills/ihr-attendance` |

## 不改动项（及理由）

- `doc/` 下历次实施/诊断文档：属于历史记录，保留当时的路径原文，不回改。
- `publish/` 下已生成的发布包：`.gitignore` 排除，由发布脚本重新生成；本次不手工改包内目录。
- 已安装的 skill（`%USERPROFILE%\.zcode\skills\ihr-attendance\`、`.agents\skills\ihr-attendance\`）：安装目录名本就带 s，与本次改名无关，无需重装。
- `src/` 代码：无任何对 `skill/` 目录的路径依赖，仅注释提到 skill，无需改动。

## 验证

1. `npm run build` 编译通过。
2. `npm test` 全部通过（含 publish 打包测试按新目录拷贝）。
3. `git status` 确认重命名被识别为 rename，无多余改动。
4. 按规约不自动签入，等待人工确认后提交。
