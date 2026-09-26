import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { LoadConfigResult } from './config.js';
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
      (e?.areaId === undefined || typeof e.areaId === 'string') &&
      (e?.area === undefined || typeof e.area === 'string'),
  );
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
        name: 'list_projects',
        description: '获取 ihr 报工项目条目列表（项目编号/名称/活动类型/客户映射）',
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
        description: '批量提交考勤工时。entries 每项: {date(YYYY-MM-DD), projectCode, activityType, hours, workContent, tsDeliveryType?(默认项目地交付), areaId?, area?}；跨周条目自动按周一~周日分组逐周提交',
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
          });
        }
        case 'list_projects':
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
          if (!isFillArgs(args)) {
            throw new McpError(ErrorCode.InvalidParams, 'entries 参数不合法');
          }
          const results = await withReauth(deps, async () => {
            const http = await deps.session.getAuthedHttp();
            return new IhrClient(http).submitWorkHours(args.entries);
          });
          return ok({ results });
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
