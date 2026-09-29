import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { LoadConfigResult, defaultConfigPath } from './config.js';
import { SessionManager } from './session.js';
import { MappingStore } from './mapping.js';
import { listProjectsWithMapping } from './service.js';
import { IhrClient, FillEntry } from './ihr/client.js';

export interface ToolDeps {
  cfg: LoadConfigResult;
  session: SessionManager;
  mapping: MappingStore;
}

function isSetMappingArgs(args: any): args is { projectCode: string; customer: string } {
  return typeof args?.projectCode === 'string' && !!args.projectCode
    && typeof args?.customer === 'string' && !!args.customer;
}

function isFillArgs(args: any): args is { entries: FillEntry[] } {
  if (!args || !Array.isArray(args.entries)) return false;
  return args.entries.every(
    (e: any) =>
      typeof e?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.date) &&
      typeof e?.projectCode === 'string' && !!e.projectCode &&
      typeof e?.activityType === 'string' &&
      typeof e?.hours === 'number' && e.hours > 0 &&
      typeof e?.workContent === 'string' &&
      (e?.tsDeliveryType === undefined || typeof e.tsDeliveryType === 'string') &&
      (e?.type === undefined || e.type === '工时' || e.type === '加班') &&
      (e?.areaId === undefined || typeof e.areaId === 'string') &&
      (e?.area === undefined || typeof e.area === 'string'),
  );
}

// 凭据未配置时快速失败（不拿占位符去撞 SSO 得到误导性的"账号或密码错误"），报错携带配置文件绝对路径
export function requireConfigOk(deps: ToolDeps): void {
  if (!deps.cfg.configOk) {
    throw new McpError(ErrorCode.InternalError, `凭据未配置: 请填写 ${defaultConfigPath()} 的 username/password 后重启服务`);
  }
}

// ihr 服务端吊销 token 时返回 errorCode=401（IhrClient.call() 抛出该形态消息）：
// invalidate 后 ensureLogin 重新登录并重试一次；其他错误原样抛出
export async function withReauth<T>(deps: ToolDeps, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: any) {
    if (/\[errorCode=401\]/.test(String(err?.message))) {
      deps.session.invalidate();
      return await fn();
    }
    throw err;
  }
}

export function createMcpServer(deps: ToolDeps): Server {
  const server = new Server(
    { name: 'ihr-mcp', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_login_status',
        description: '检查 ihr 登录状态与凭据配置',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
      },
      {
        name: 'get_config',
        description: '获取非敏感运行配置（如 projectsRoot，供 skill 动态取扫描根目录）。凭据永不出 MCP',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
      },
      {
        name: 'list_projects',
        description: '获取 ihr 报工项目条目列表（当月口径；项目编号/名称/活动类型/客户映射/项目期望起止时间 expectedStartDate/expectedEndDate。提交时按填报周校验条目有效期）',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
      },
      {
        name: 'get_customer_mapping',
        description: '读取项目编号→客户名映射表',
        inputSchema: { type: 'object' as const, properties: {}, required: [] },
      },
      {
        name: 'set_customer_mapping',
        description: '设置项目编号→客户名映射（覆盖自动推断）',
        inputSchema: {
          type: 'object' as const,
          properties: {
            projectCode: { type: 'string' },
            customer: { type: 'string' },
          },
          required: ['projectCode', 'customer'],
        },
      },
      {
        name: 'fill_work_hours',
        description: '批量提交考勤工时。entries 每项: {date(YYYY-MM-DD), projectCode, activityType, hours, workContent, type?(工时=默认/加班=非工作日，加班时 workContent 为加班原因), tsDeliveryType?(默认公司远程交付), areaId?, area?(公司远程交付缺省ODC集中交付区域（顺德）)}；跨周条目自动按周一~周日分组逐周提交',
        inputSchema: {
          type: 'object' as const,
          properties: {
            entries: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  date: { type: 'string' },
                  projectCode: { type: 'string' },
                  activityType: { type: 'string' },
                  hours: { type: 'number' },
                  workContent: { type: 'string' },
                  type: { type: 'string', enum: ['工时', '加班'] },
                  tsDeliveryType: { type: 'string' },
                  areaId: { type: 'string' },
                  area: { type: 'string' },
                },
                required: ['date', 'projectCode', 'activityType', 'hours', 'workContent'],
              },
            },
          },
          required: ['entries'],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const ok = (payload: unknown) => ({
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    });
    try {
      switch (name) {
        case 'get_login_status': {
          const t = deps.session.getTokenInfo();
          return ok({
            configOk: deps.cfg.configOk,
            loggedIn: t.loggedIn,
            username: deps.cfg.username,
            tokenExpiresAt: t.tokenExpiresAt,
            configPath: defaultConfigPath(),
          });
        }
        case 'get_config':
          // 只暴露非敏感路径配置；username/password 永不出 MCP（skill 经此动态取扫描根目录）
          return ok({ projectsRoot: deps.cfg.projectsRoot });
        case 'list_projects':
          requireConfigOk(deps);
          return ok({ projects: await withReauth(deps, () => listProjectsWithMapping(deps)) });
        case 'get_customer_mapping':
          return ok({ mapping: deps.mapping.load() });
        case 'set_customer_mapping': {
          if (!isSetMappingArgs(args)) {
            throw new McpError(ErrorCode.InvalidParams, '参数必须是 {projectCode, customer}');
          }
          deps.mapping.set(args.projectCode, args.customer);
          return ok({ ok: true });
        }
        case 'fill_work_hours': {
          requireConfigOk(deps);
          if (!isFillArgs(args)) {
            throw new McpError(ErrorCode.InvalidParams, 'entries 参数不合法');
          }
          // client 实例跨 401 重试保留：succeededWeeks 记忆已成功周，重登重试后不重复提交。
          // getAuthedHttp 返回构造时的共享 this.http 单例（session.ts:20-24, 50），每次调用先
          // ensureLogin（invalidate 后重登）并重写同一实例的 Authorization 头（session.ts:47-49），
          // 故重试时无需重建 client，只需每次尝试重新 getAuthedHttp 刷新头
          let client: IhrClient | undefined;
          return ok({ results: await withReauth(deps, async () => {
            const http = await deps.session.getAuthedHttp();
            client = client ?? new IhrClient(http);
            return client.submitWorkHours(args.entries);
          }) });
        }
        default:
          throw new McpError(ErrorCode.MethodNotFound, `未知工具: ${name}`);
      }
    } catch (err: any) {
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, err?.message ?? String(err));
    }
  });

  return server;
}
