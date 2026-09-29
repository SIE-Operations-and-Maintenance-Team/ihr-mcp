# ihr-mcp

赛意 iHR 考勤自动填报 MCP 服务端 + 配对填报考勤 skill。

对接 `https://ihr.chinasie.com`（赛意统一认证 SSO + 考勤工时模块），把"打开网页→选项目→逐日填工时"变成一句话：agent 扫描本地项目文档 → 生成考勤填报文档 → 用户确认 → 自动提交。

- **传输协议**：Streamable HTTP（`/mcp` 端点，任意支持 MCP 的客户端可接入）+ Web 管理页面
- **技术栈**：Node.js ≥20、TypeScript、`@modelcontextprotocol/sdk`
- **配套 skill**：`skill/ihr-attendance/`（教 agent 走完整填报流程，已做 agent 无关化，不绑定 ZCode）

## 功能特性

- **SSO 自动登录**：复用统一认证中心接口（AES 加密密码），token 缓存 7 天，失效/被吊销自动重登重试
- **报工条目获取**：按当月拉取可填报项目，解析项目编号/名称/活动类型，自动推断项目归属客户（可手动修正）
- **考勤提交**：按周一~周日自动分组、逐周批量提交；工作日默认"工时"，周末/节假日支持"加班"类型；默认交付类型"公司远程交付"（实施地点 ODC集中交付区域（顺德）），项目地交付等类型可指定并自动带出项目地点
- **Web 管理页**：登录状态、在线配置（用户名/密码/端口等，保存自动重启）、项目列表、项目↔客户映射修正（一键保存）
- **配对 skill**：扫描本地项目 doc 文档 → 归纳每日工作 → 生成考勤填报文档 → **用户硬性确认后**自动提交；内置法定节假日缓存（每年只拉取一次，自动区分放假日/调休上班日）与阶梯取整填报规则
- **Windows 服务部署**：一条 cmd 装成系统服务（开机自启）；离线发布包打包，同事零依赖安装

## 环境要求

- Node.js **≥ 20**（服务运行时；安装服务/填报表的机器都需要）
- Windows（服务部署与发布打包；Linux/macOS 下 `node dist/index.js` 亦可运行服务本体）

## 快速开始（发布包部署，推荐给使用同事）

1. 拿到发布包 `ihr-mcp-v<版本>.zip`（由负责人 `publish.cmd` 生成），解压到任意目录
2. 双击 **`service-install.cmd`**（UAC 点"是"）——自动安装并启动 Windows 服务
3. 首次启动会在解压目录生成 `config.json` 模板，填入 ihr 的 `username` / `password`
4. 双击 **`ihr-service.cmd`**，选择 restart（或管理员命令行执行 `ihr-service.cmd restart`）
5. 浏览器打开管理页 `http://127.0.0.1:13210/` 确认登录状态与项目列表
6. 在你的 MCP 客户端注册 ihr 服务（见下文），并安装填报考勤 skill（见下文）

## 从源码运行（开发）

```bash
npm install
npm run build
node dist/index.js -t http        # 前台运行；npm start 等价
```

首次启动自动在程序根目录生成 `config.json` 模板，填入凭据后重启。开发调试可用 `node dist/index.js -t stdio` 走标准输入输出传输。

## 配置

配置文件：**程序根目录 `config.json`**（与 `service-install.cmd` 同级）。不存在时程序启动自动生成模板；已存在则不覆盖。

```json
{
  "username": "ihr用户名（工号/手机号）",
  "password": "ihr密码",
  "port": 13210,
  "host": "127.0.0.1",
  "projectsRoot": "F:\\项目"
}
```

| 字段 | 说明 |
|------|------|
| `username` / `password` | ihr 登录凭据（明文存本机；该文件已被 .gitignore 排除，不入库、不进发布包） |
| `port` / `host` | 服务监听地址，优先级：命令行 `-p/-h` > config.json > 默认（13210/127.0.0.1） |
| `projectsRoot` | 本地项目根目录（skill 扫描 doc 工作文档、Web 页客户下拉的来源） |

网页端右上角"⚙ 配置"可在线修改以上字段（密码留空=保持不变），保存后服务自动重启生效。

另有 `mapping.json`（同目录）保存"项目编号 → 客户名"的手动映射，可在 Web 页修改，也可由 `set_customer_mapping` 工具写入。

> 直接编辑配置文件的话，改完需重启服务生效（`ihr-service.cmd restart`）；网页端保存会自动重启，无需手动操作。

## MCP 客户端接入

服务地址：`http://127.0.0.1:<port>/mcp`（Streamable HTTP）。

ZCode：编辑 `%USERPROFILE%\.zcode\cli\config.json` 的 `mcp.servers` 段：

```json
{
  "mcp": {
    "servers": {
      "ihr": {
        "type": "http",
        "url": "http://127.0.0.1:13210/mcp"
      }
    }
  }
}
```

其他支持 MCP 的客户端（Claude Code 等）按各自格式注册同一 URL 即可。

## MCP 工具（6 个）

| 工具 | 入参 | 说明 |
|------|------|------|
| `get_login_status` | 无 | 登录状态、凭据配置检查；返回 `configPath`（配置文件绝对路径） |
| `get_config` | 无 | 非敏感运行配置（`projectsRoot`）。**凭据永不出 MCP** |
| `list_projects` | 无 | 当月可填报项目：`{projectCode, projectName, activityType, customer, customerSource, expectedStartDate/expectedEndDate, ...}` |
| `get_customer_mapping` | 无 | 项目编号→客户名映射表 |
| `set_customer_mapping` | `{projectCode, customer}` | 修正项目↔客户映射（覆盖自动推断） |
| `fill_work_hours` | `{entries: [...]}` | 批量提交考勤，自动按周一~周日分周批量提交。每项：`{date, projectCode, activityType, hours, workContent, type?(工时=默认/加班=非工作日), tsDeliveryType?(默认公司远程交付), areaId?, area?(公司远程交付缺省ODC集中交付区域（顺德）)}` |

提交语义与防护：周级批量全或无；`configOk=false` 时快速失败并携带配置文件绝对路径；token 失效自动重登后重试一次，已成功周不会重复提交。

## Web 管理页

`http://127.0.0.1:<port>/`

- 登录状态卡片（凭据未配置时提示配置文件位置）
- 右上角 **⚙ 配置**：在线修改用户名/密码（留空=保持）/项目根目录/IP/端口，"保存并重启生效"一键应用（服务自动重启，页面跳转新地址）
- 项目列表：编号、名称、活动类型、**客户下拉修正**（来源标注：手动/推断/未匹配）
- 修改客户下拉即保存到 mapping.json，后续 `list_projects` 与填报自动生效

## 填报考勤 skill（ihr-attendance）

`skill/ihr-attendance/SKILL.md`，按所用 agent 的技能目录安装（**目录名保持 `ihr-attendance`**）：

| agent | 安装到 |
|-------|--------|
| ZCode | `%USERPROFILE%\.zcode\skills\ihr-attendance\` |
| Claude Code | `%USERPROFILE%\.claude\skills\ihr-attendance\` |
| 通用（跨工具） | `%USERPROFILE%\.agents\skills\ihr-attendance\` |

安装后对 agent 说"**填报考勤**"即可。skill 流程：

1. 检查登录态（未配置凭据时按 `configPath` 指导填写，agent 不接触密码）
2. 确定报工周期与填报口径（默认当月；阶梯取整：累计 ≥2 报 4、>4 报 8，单日合计 ≤8h）；获取当年**法定节假日缓存** `<projectsRoot>\doc\holidays-<年>.json`（每年每年份只联网拉取一次；放假日报"加班"、调休上班日报"工时"，如 2026-09-20/10-10 调休）
3. 扫描各项目 `doc/` 下的工作文档（前缀/后缀日期双命名匹配、两段式扫描、跨月合并、mtime 补扫兜底）
4. 归纳每日工作 → 匹配 ihr 项目（映射表优先；**一客户多项目时归属判断必须经用户逐条确认**，确认后可写入映射固化；无对应项目的行挂起待派工）
5. 生成考勤填报文档（`<projectsRoot>\doc\` 下，10 列明细含 实际(h)/报工(h) 双列与 交付类型/实施地点；同日同项目同活动类型合并一行；空档日标注原因）
6. 【硬性关口】等用户确认或修改文档（重点提示：多项目归属行、周末/节假日/调休日、交付类型默认值、统一工作内容项目）
7. 确认后自动提交（提交前复核项目条目有效性，支持分批），以**提交状态表**逐条记录结果，失败按判读表处置、仅重提失败条目

## Windows 服务管理

| 操作 | 方式 |
|------|------|
| 安装并启动 | 双击 `service-install.cmd`（自提升管理员权限） |
| 卸载 | `service-uninstall.cmd` |
| 启动/停止/重启/状态 | `ihr-service.cmd start\|stop\|restart\|status` |

服务基于 node-windows（随发布包分发，同事机器无需额外下载）。更新代码后：`npm run build` → `ihr-service.cmd restart`。

## 打包发布给同事

负责人机器上双击 **`publish.cmd`**：生成 `publish\ihr-mcp-v<版本>.zip`，内含编译产物、生产依赖（node-windows 等，同事机器无需 npm/联网）、部署 cmd 与 skill 源。本机凭据与映射数据不会进包。

发布目录可就地部署。对同一个版本目录重新打包前，先运行该目录的 `ihr-service.cmd stop` 并确认实际服务已停止，再执行 `publish.cmd`。打包程序核对服务注册路径与守护配置，将 `config.json`、`mapping.json` 和有效的 `dist/daemon` 守护文件备份到发布目录同级的 `.ihr-deploy-backup-*` 目录。纯净 ZIP 校验完成后还原这些文件；ZIP 不包含本机配置或守护。只有打包成功后才运行 `ihr-service.cmd start`。失败时保持停服，按输出的备份位置恢复配置与守护，并先确认应用文件完整；本流程不提供整个应用的自动回滚。

若发现孤立或损坏的守护，先核对目标部署目录，再执行 `service-uninstall.cmd` → `service-install.cmd` 恢复，不能直接忽略错误继续打包。卸载会在确认注册消失后将守护移到 `.ihr-service-backup-*` 目录，保留程序与配置。备份可能含本机配置，只在本机保留，确认无需恢复后再清理，不随发布包分发。

版本号改变会生成另一个目录，旧服务继续指向旧目录，配置与服务不会自动迁移。建议从长期固定的目录安装服务；需要迁移时明确处理旧部署后再安装新部署。

### 发布失败恢复

npm、复制或压缩失败可能使 stage 内的脚本和依赖不完整。应从完整的打包仓库根目录调用共用模块，并使用报错给出的备份路径；只处理同一版本目录，并在服务停止后执行：

```powershell
$env:IHR_RECOVER_STAGE = Read-Host '输入失败发布的 stage 绝对路径'
$env:IHR_RECOVER_BACKUP = Read-Host '输入本次报错输出的 .ihr-deploy-backup-* 绝对路径'
node --input-type=module -e "import {readFileSync} from 'node:fs'; import {join} from 'node:path'; import {serviceFor,normalizePath} from './scripts/service-state.mjs'; import {restoreBackup} from './scripts/publish-preserve.mjs'; const root=process.env.IHR_RECOVER_STAGE; const expected=join(process.cwd(),'publish','ihr-mcp-v'+JSON.parse(readFileSync('package.json','utf8')).version); if(normalizePath(root)!==normalizePath(expected)) throw new Error('目标不是本仓库当前版本的 stage，请按迁移流程处理'); const svc=serviceFor(root); if(svc && svc.State!=='Stopped') throw new Error('先停止关联服务'); restoreBackup(root,process.env.IHR_RECOVER_BACKUP);"
if ($LASTEXITCODE -ne 0) { throw '备份还原失败，保持停服并保留现场' }
node --input-type=module -e "import {uninstallService} from './scripts/service-control.mjs'; await uninstallService(process.env.IHR_RECOVER_STAGE);"
if ($LASTEXITCODE -ne 0) { throw '残留服务处理失败，保留现场' }
node scripts/publish.mjs
if ($LASTEXITCODE -ne 0) { throw '重新构建仍失败，保持停服并保留新旧备份' }
node --input-type=module -e "import {installService} from './scripts/service-control.mjs'; await installService(process.env.IHR_RECOVER_STAGE);"
if ($LASTEXITCODE -ne 0) { throw '服务未通过恢复验收，请检查状态与日志' }
```

此流程保留配置并重新生成应用目录，不提供完整应用回滚。不要自动选择“最新备份”；版本目录变化时按迁移流程处理。

## 常见问题

| 现象 | 处理 |
|------|------|
| 工具报"凭据未配置: 请填写 …config.json…" | 按报错中的路径填入 username/password，重启服务 |
| 登录失败 [code=40009] | 密码已过期，到统一认证中心重置后更新 config.json |
| 登录失败 账号或密码错误 [code=40001] | 核对 config.json 凭据（报错末尾附有配置文件路径） |
| 端口被占用 | 安装/启动会报告冲突，不会强杀 PID。核实占用者后有序停止目标实例，或修改配置端口；不要结束无关进程。 |
| 提交报"已存在工时填报申请单" | 该日已填报（项目经理代报或重复提交），跳过该日即可 |
| 节假日数据有误或想刷新缓存 | 删除 `<projectsRoot>\doc\holidays-<年>.json`，下次填报自动重拉 |
| ihr 页面改版后工具报错 | 接口路径/字段集中在 `src/ihr/client.ts` 常量区与 `doc/` 逆向文档，按新页面重新逆向修正 |

## 项目文档

- [doc/20260926-ihr-mcp设计文档.md](doc/20260926-ihr-mcp设计文档.md) — 架构、模块、数据流
- [doc/20260926-ihr-mcp实施计划.md](doc/20260926-ihr-mcp实施计划.md) — 任务拆解与历次修订记录
- [doc/20260926-ihr接口逆向结果.md](doc/20260926-ihr接口逆向结果.md) — SSO/考勤接口实证（鉴权、字段映射、交付类型矩阵）

## 目录结构

```
ihr-mcp/
├── service-install.cmd / service-uninstall.cmd / ihr-service.cmd   # Windows 服务
├── publish.cmd                    # 离线发布包打包
├── config.json / mapping.json     # 运行配置（本机生成，不入库）
├── skill/ihr-attendance/SKILL.md  # 填报考勤 skill 源
├── src/
│   ├── index.ts                   # 入口：/mcp + /api/* + Web 页
│   ├── config.ts session.ts mapping.ts service.ts tools.ts
│   ├── sso/                       # SSO 密码加密与登录
│   ├── ihr/                       # ihr 接口客户端与条目解析
│   └── web/                       # 管理页面
├── scripts/                       # 服务安装/连调/发布脚本
├── test/                          # vitest 单元测试
└── doc/                           # 设计/计划/逆向文档
```

## 安全说明

- 凭据明文保存于本机 `config.json`（内网个人电脑场景；如需可扩展 DPAPI 加密）
- `config.json` / `mapping.json` / `publish\` 均被 .gitignore 排除，永不入库、不进发布包
- MCP 端点与服务仅绑定 127.0.0.1；Web 接口校验 Host 防跨主机访问
