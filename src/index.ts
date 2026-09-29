#!/usr/bin/env node
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, ensureConfigTemplate, defaultConfigPath, resolveServerAddress } from './config.js';
import { SessionManager } from './session.js';
import { MappingStore } from './mapping.js';
import { createMcpServer } from './tools.js';
import { createWebApi } from './web/api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const program = new Command();
program
  .name('ihr-mcp')
  .version('0.2.0')
  .option('-t, --transport <type>', '传输类型 (http, stdio)', 'http')
  .option('-p, --port <number>', 'HTTP 端口（优先级：命令行 > config.json > 13210）')
  .option('-h, --host <host>', '监听地址（优先级：命令行 > config.json > 127.0.0.1）')
  .parse();
const opts = program.opts();

async function main(): Promise<void> {
  // 执行时自动判断程序目录下是否有配置，没有才生成占位符模板（编译时不生成配置）
  if (ensureConfigTemplate()) {
    console.error(`已生成配置模板: ${defaultConfigPath()}，请填入 username/password 后重启`);
  }
  const cfg = loadConfig();
  const session = new SessionManager(cfg);
  const mapping = new MappingStore();
  const server = createMcpServer({ cfg, session, mapping });

  if (opts.transport === 'stdio') {
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    await server.connect(new StdioServerTransport());
    return;
  }

  const { port, host } = resolveServerAddress(cfg, opts);
  const webApi = createWebApi({ cfg, session, mapping });

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    if (url.pathname === '/mcp') {
      try {
        // SDK 无状态模式（sessionIdGenerator: undefined）共享 transport 实例会话类错误（初始化 notification 500），
        // 改为每请求新建 server 与 transport 实例、connect 后再 handleRequest
        const perReqServer = createMcpServer({ cfg, session, mapping });
        const perReqTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await perReqServer.connect(perReqTransport);
        await perReqTransport.handleRequest(req, res);
      } catch (err) {
        console.error('[/mcp]', err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end('Internal Server Error');
        }
      }
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await webApi(req, res);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(__dirname, 'web', 'public', 'index.html')));
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
  });

  httpServer.listen(port, host, () => {
    console.error(`ihr-mcp 启动: MCP http://${host}:${port}/mcp | 管理 http://${host}:${port}/`);
    if (!cfg.configOk) {
      console.error('警告: 程序根目录 config.json 未配置凭据，工具调用将失败');
    }
  });
}

main().catch((e) => {
  console.error('Fatal:', e?.message ?? e);
  process.exit(1);
});
