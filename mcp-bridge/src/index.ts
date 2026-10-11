#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WinkilandAgent } from "@winkiland/agent";
import { registerTools } from "./tools.js";

const log = (msg: string) => process.stderr.write(`[winkiland-mcp] ${msg}\n`);

async function main(): Promise<void> {
  const agent = new WinkilandAgent({ log });
  agent.on("fatal", ({ code, reason }) => log(`agente detenido: ${reason} (${code})`));
  agent.on("reconnecting", ({ attempt, delayMs }) => log(`reconectando en ${delayMs} ms (intento ${attempt})`));
  const welcome = await agent.connect();
  log(`conectado como ${welcome.agent.name}`);
  const room = process.env.WINKILAND_START_ROOM;
  if (room) await agent.join(room).catch((err: Error) => log(`no pude entrar a ${room}: ${err.message}`));

  const server = new McpServer({ name: "winkiland", version: "0.1.0" });
  registerTools(server, agent);
  await server.connect(new StdioServerTransport());

  const stop = () => {
    void agent.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  process.stdin.on("close", stop);
}

main().catch((err: Error) => {
  log(err.message);
  process.exit(1);
});
