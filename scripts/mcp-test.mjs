// 手动连调：MCP 客户端 → list_tools → get_login_status。先 npm run build。
// 服务端口/地址取程序目录 dist/config.json（缺省回落 3210/127.0.0.1）
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const here = dirname(fileURLToPath(import.meta.url));
let port = 3210;
let host = '127.0.0.1';
try {
  const cfg = JSON.parse(readFileSync(join(here, '..', 'dist', 'config.json'), 'utf8'));
  port = cfg.port ?? port;
  host = cfg.host ?? host;
} catch { /* 配置不存在用默认 */ }

const transport = new StreamableHTTPClientTransport(new URL(`http://${host}:${port}/mcp`));
const client = new Client({ name: 'ihr-smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
console.log('工具列表:', tools.tools.map((t) => t.name).join(', '));

const status = await client.callTool({ name: 'get_login_status', arguments: {} });
console.log('登录状态:', status.content[0].text);

await client.close();
