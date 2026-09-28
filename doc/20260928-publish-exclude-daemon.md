# 实施记录：发布包排除 dist\daemon 并保护就地部署

- **日期**：2026-09-28
- **状态**：代码修改完成，真实服务主路径验收通过；交互式 UAC 取消场景待完成
- **关联诊断**：doc/bug-diagnosis-config-write-path-20260928.md、doc/bug-diagnosis-service-reinstall-broken-20260928.md
- **实施方案**：doc/20260928-publish-preserve-deemon.md

---

## 背景

诊断确认：Windows 服务虽然注册在 `publish\ihr-mcp-v0.1.0\dist\daemon\ihrmcp.exe`，
但 `scripts/publish.mjs` 打包时整个 `dist` 递归拷贝（filter 只排除
config.json/mapping.json），把打包机仓库里旧安装的 `dist\daemon\`（`ihrmcp.xml` 写死
`F:\GitHubs\ihr-mcp\dist\index.js` 等仓库路径）原样带进了发布包，覆盖了部署目录原本
正确的守护配置。服务按污染后的 xml 启动 → 一直运行仓库代码 → 配置回写仓库根。

## 修改目标

仓库 `dist/daemon` 不进入发布内容，避免打包机路径污染目标机器。此排除本身不会保留已部署目录的守护；配置与有效守护的备份、校验和恢复由关联方案 A+B 完成。

## 实施内容

`scripts/publish.mjs` 保留仓库 daemon 排除和 stage 自检；发布流程先检查关联服务已停止并校验目录归属，将本机配置及有效守护备份到 stage 外，构建纯净 stage 并校验临时 ZIP，数据还原成功后才替换正式 ZIP。失败时返回非零并尝试清理临时包，备份留待人工恢复。

新增 `scripts/service-state.mjs`、`scripts/publish-preserve.mjs` 和 `scripts/service-control.mjs`，统一 SCM/路径检查、磁盘备份还原及服务生命周期操作；更新服务与发布入口，移除按端口强杀 PID，并保留命令退出码。

## 操作边界

- 打包前必须由操作者确认关联服务已停止；脚本不会自动停止或在失败后自动启动服务。
- ZIP 不包含本机 `config.json`、`mapping.json` 或 `dist/daemon`；stage 在打包成功后可恢复经校验的本机文件。
- 卸载确认 SCM 注册消失后，把残留守护移到 `.ihr-service-backup-*`，保留程序文件和配置。
- 失败恢复仅覆盖配置与守护，不承诺完整应用回滚；版本目录变化不自动迁移旧服务或配置。

## 验证方式

代码门禁：6 个 `.mjs` 通过 `node --check`，`npm run build` 通过，全量测试 140 项通过；原生 CMD fixture 覆盖普通和提权分支的退出码。隔离 fixture 测试了配置/守护还原、构建失败、ZIP 校验失败和备份重试。

隔离验收目录 `publish/acceptance-20260928` 中已生成真实 ZIP 并核验 4303 个条目，无本机配置、daemon 或 TypeScript 依赖，必需条目齐全。真实服务主路径验收通过：运行中发布返回非零且五个保护文件 hash 不变；停止后发布成功并恢复五个 hash，SCM `PathName` 未变且保持 Stopped；启动、重启、两种注册/守护不一致状态和端口冲突均按预期完成。结束时 `ihrmcp.exe`、`ihr-mcp` 均未注册。`service-install.cmd` 的 UAC 批准分支返回 0；交互式取消分支未能确认，不能记为通过。详细结果保存在隔离目录的 `service-acceptance-results.txt`。

## 影响面

- 发布包体积略减（不再带 daemon 二进制与日志）。
- 同事机器全新安装：安装时 node-windows 会重新生成守护文件，本改动不影响。
- 本机已安装服务：需配合一次性环境修复（诊断报告 A 部分）才能纠正运行目录。
