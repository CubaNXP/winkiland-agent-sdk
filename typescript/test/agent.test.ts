import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { after, describe, it } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { WinkilandAgent, WinkilandError } from "../src/index.js";

const TOKEN = `wk_agent_${"a".repeat(43)}`;

interface Fake {
  url: string;
  server: Server;
  sockets: WebSocket[];
  frames: Record<string, unknown>[];
  onRequest: (ws: WebSocket, req: Record<string, unknown>) => void;
  close(): Promise<void>;
}

function welcome(): string {
  return JSON.stringify({
    type: "welcome",
    protocol: 1,
    agent: { id: "a1", entityId: "x:a1", name: "Test", owner: "dueno" },
    rooms: { lobby: "L", casino: "C", music: "M", jobs: "J", home: "H" },
    limits: { requestsPerSecond: 8, burst: 20, chatPerMinute: 48, maxTextLength: 200, stepMs: 350 },
  });
}

function ok(ws: WebSocket, id: unknown, data: unknown): void {
  ws.send(JSON.stringify({ type: "result", id, ok: true, data }));
}

async function fake(options: { status?: number } = {}): Promise<Fake> {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const f: Fake = {
    url: "",
    server,
    sockets: [],
    frames: [],
    onRequest: (ws, req) => {
      if (req.type === "join") {
        ws.send(JSON.stringify({ type: "event", seq: 1, event: "room", data: { room: { id: "L", name: "Lobby", kind: "lobby" }, selfId: "x:a1", entities: [{ id: "x:a1", kind: "agent", name: "Test", x: 0, y: 1, seated: false }, { id: "u:1", kind: "human", name: "ana", x: 1, y: 1, seated: false }], chat: [] } }));
        ok(ws, req.id, { room: { id: "L", name: "Lobby", kind: "lobby" }, self: { id: "x:a1" } });
        return;
      }
      ok(ws, req.id, { echo: req.type });
    },
    close: () =>
      new Promise((resolve) => {
        for (const s of wss.clients) s.terminate();
        wss.close();
        server.close(() => resolve());
      }),
  };
  server.on("upgrade", (req, socket, head) => {
    if (options.status) {
      socket.end(`HTTP/1.1 ${options.status} Nope\r\n\r\n`);
      return;
    }
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
    wss.handleUpgrade(req, socket, head, (ws) => {
      f.sockets.push(ws);
      ws.send(welcome());
      ws.on("message", (raw) => {
        const req = JSON.parse(raw.toString()) as Record<string, unknown>;
        f.frames.push(req);
        f.onRequest(ws, req);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  f.url = `ws://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/agent`;
  return f;
}

const servers: Fake[] = [];
after(async () => {
  for (const s of servers) await s.close();
});

describe("WinkilandAgent", () => {
  it("rejects bad tokens and insecure remote urls before connecting", () => {
    assert.throws(() => new WinkilandAgent({ token: "nope" }), WinkilandError);
    assert.throws(() => new WinkilandAgent({ token: TOKEN, url: "ws://example.com/agent" }), /wss/);
  });

  it("connects, joins, tracks entities and answers requests", async () => {
    const f = await fake();
    servers.push(f);
    const agent = new WinkilandAgent({ token: TOKEN, url: f.url });
    const w = await agent.connect();
    assert.equal(w.agent.name, "Test");
    const joined = await agent.join("lobby");
    assert.equal(joined.room.kind, "lobby");
    assert.equal(agent.room?.name, "Lobby");
    assert.deepEqual(agent.nearby(2).map((e) => e.name), ["ana"]);
    assert.deepEqual(await agent.say("hola"), { echo: "say" });
    assert.equal(f.frames.find((x) => x.type === "say")?.text, "hola");
    await agent.close();
  });

  it("resends the same request id once when the answer is late", async () => {
    const f = await fake();
    servers.push(f);
    let seen = 0;
    f.onRequest = (ws, req) => {
      if (req.type !== "move") return ok(ws, req.id, {});
      seen += 1;
      if (seen === 2) ok(ws, req.id, { x: 3, y: 4 });
    };
    const agent = new WinkilandAgent({ token: TOKEN, url: f.url, requestTimeoutMs: 200 });
    await agent.connect();
    assert.deepEqual(await agent.moveTo(3, 4), { x: 3, y: 4, arrived: false });
    const moves = f.frames.filter((x) => x.type === "move");
    assert.equal(moves.length, 2);
    assert.equal(moves[0]!.id, moves[1]!.id);
    await agent.close();
  });

  it("reconnects with backoff and goes back to the last room", async () => {
    const f = await fake();
    servers.push(f);
    const agent = new WinkilandAgent({ token: TOKEN, url: f.url, minBackoffMs: 50, maxBackoffMs: 100 });
    const events: string[] = [];
    agent.on("reconnecting", () => events.push("reconnecting"));
    agent.on("connected", () => events.push("connected"));
    await agent.connect();
    await agent.join("casino");
    f.sockets[0]!.terminate();
    await agent.waitFor("room", () => true, 3_000);
    const joins = f.frames.filter((x) => x.type === "join").map((x) => x.room);
    assert.deepEqual(joins, ["casino", "casino"]);
    assert.deepEqual(events, ["connected", "reconnecting", "connected"]);
    await agent.close();
  });

  it("stops for good when the token is revoked", async () => {
    const f = await fake();
    servers.push(f);
    const agent = new WinkilandAgent({ token: TOKEN, url: f.url, minBackoffMs: 20 });
    await agent.connect();
    const fatal = agent.waitFor("fatal", () => true, 2_000);
    f.sockets[0]!.close(4003, "revoked");
    assert.equal((await fatal).code, 4003);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(f.sockets.length, 1);
    await assert.rejects(agent.say("hola"), /no está conectado/);
  });

  it("fails connect() on 401 without retrying", async () => {
    const f = await fake({ status: 401 });
    servers.push(f);
    const agent = new WinkilandAgent({ token: TOKEN, url: f.url, minBackoffMs: 20 });
    await assert.rejects(agent.connect(), (err: WinkilandError) => err.code === "401");
  });
});
