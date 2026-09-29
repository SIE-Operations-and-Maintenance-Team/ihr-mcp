# Bug 诊断报告：网页配置回写路径为仓库根 config.json

- **日期**：2026-09-28
- **状态**：已确认（根因已实锤；代码路径逻辑符合设计，问题出在打包污染守护配置）
- **严重级别**：P1 严重（Windows 服务实际运行的是错误目录的程序；配置与部署目录脱钩）
- **报告人**：ZCode Agent（Bug Diagnosis Skill）

---

## 问题描述

用户的 Windows 服务安装在 `F:\GitHubs\ihr-mcp\publish\ihr-mcp-v0.1.0\dist\daemon\ihrmcp.exe`，
期望网页面板保存的配置写到部署根目录（`publish\ihr-mcp-v0.1.0\config.json`，与
service-install.cmd 同级）；实际却回写到 `F:\GitHubs\ihr-mcp\config.json`（仓库根）。

## 环境信息

- 分支/版本：main，46fd297（v0.1.0）
- 服务：`ihrmcp.exe`（RUNNING，AUTO_START，LocalSystem），BINARY_PATH 指向 publish 目录守护 exe
- 复现步骤：打开面板保存配置 → 落点为仓库根 config.json

## 根因（证据链完整）

**该服务虽然"装在"publish 目录，但守护配置让它运行的是仓库里的程序**，配置路径跟随运行中
模块的位置，因此落点为仓库根。

证据链（每条均已实际取证）：

1. **守护 xml 写死仓库路径**：`publish\ihr-mcp-v0.1.0\dist\daemon\ihrmcp.xml` 中
   `--file F:\GitHubs\ihr-mcp\dist\index.js`、`wrapper.js` 取自
   `F:\GitHubs\ihr-mcp\node_modules\...`、`<workingdirectory>F:\GitHubs\ihr-mcp` ——
   三处全是仓库路径。winsw 守护 exe 启动时读取同目录 xml 拉起脚本。
2. **publish 目录的 xml 是仓库份的拷贝**：两份 `ihrmcp.xml` 内容逐字节一致，mtime 精确到
   100ns 相同（2026-09-28 13:33:07.607663400）——`scripts/publish.mjs:50-53` 打包时整个
   `dist` 递归拷贝，filter 只排除了 config.json/mapping.json，**未排除 `dist\daemon\`**，
   把打包机旧安装的守护文件带进了发布包，覆盖了部署目录原先正确的守护配置。
3. **时间线吻合**：wrapper.log 显示 14:39:37 启动、14:43:36 停止、14:43:39 重启；
   仓库根 config.json 的 mtime 为 14:43:33（面板保存触发的写入），随后 14:43:36 的
   停止正是保存后面板自动调用的 `/api/restart`（服务模式 net stop/start）。
4. **路径解析代码本身正确**：`src/config.ts:24-30` 的 `configDir()` 取 dist 的上一级
   （= service-install.cmd 所在目录，即"程序根目录"）。**用户期望的部署根目录落盘正是该
   设计行为**——只要进程运行的是 publish 目录下的 dist，配置就会写到
   `publish\ihr-mcp-v0.1.0\config.json`。

## 排除项

- `configDir()` 路径解析逻辑：符合设计（dist 上一级），无需修改。
- `updateConfig`/`defaultConfigPath`/API 链路：行为正确（`src/web/api.ts:44,50` 如实返回运行实例的路径）。
- cwd 影响：已排除，代码不使用 `process.cwd()` 定位配置。

## 修复方案（两部分）

### A. 环境修复（不改代码，需用户确认后执行）

1. `ihr-service.cmd stop` 停服务（当前服务的名字是 `ihrmcp.exe`，脚本已双兼容）；
2. 从 publish 目录运行 `service-uninstall.cmd` 卸载服务；
3. 删除被污染的 `publish\ihr-mcp-v0.1.0\dist\daemon\` 目录；
4. 从 publish 目录运行 `service-install.cmd` 重装——包内 `scripts/service-install.mjs`
   已含 `id: 'ihr-mcp'` 修复，且包内自带 node-windows，会重新生成指向
   `publish\...\dist\index.js` 的守护 xml（服务内部名变为 `ihr-mcp`，restart 脚本双兼容）；
5. 配置迁移：将仓库根 `config.json`（真实凭据）、`mapping.json`（客户映射）复制到
   `publish\ihr-mcp-v0.1.0\` 下；或重装后在面板重新填写；
6. 打开面板确认"配置文件路径"显示 `F:\GitHubs\ihr-mcp\publish\ihr-mcp-v0.1.0\config.json`。

临时替代（不推荐）：手动编辑 `ihrmcp.xml` 的三处仓库路径后重启服务。

### B. 代码修复（防止复发，另见实施文档 20260928-publish-exclude-daemon.md）

`scripts/publish.mjs` 打包 filter 增加 `dist\daemon` 排除——发布包不再携带打包机的守护
文件；对已就地安装服务的目录重新打包时也不会再覆盖其守护配置。已验证
`publish.mjs:33` 的"已装服务需重启"警告位于 rmSync 之前、检测的是重打包前状态，不受影响。

## 总结

一句话：**配置回写路径的代码逻辑没有问题（配置 = 部署根目录），坏在发布包把打包机的
`dist\daemon\` 守护配置带了进去，导致部署目录的服务一直在运行仓库里的程序。** 先按 A
修复环境并迁移配置，再按 B 修打包脚本防复发。
