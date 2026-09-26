// 手动连调：MCP 客户端 → list_tools → get_login_status。先 npm run build && npm start
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:3210/mcp'));
const client = new Client({ name: 'ihr-smoke', version: '0.0.1' });
await client.connect(transport);

const tools = await client.listTools();
console.log('工具列表:', tools.tools.map((t) => t.name).join(', '));

const status = await client.callTool({ name: 'get_login_status', arguments: {} });
console.log('登录状态:', status.content[0].text);

await client.close();
