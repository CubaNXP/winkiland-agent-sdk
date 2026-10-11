import WebSocket from "ws";
import {
  DEFAULT_URL,
  WinkilandError,
  type AgentEventName,
  type AgentEvents,
  type ChatMessage,
  type Emote,
  type Entity,
  type Interactable,
  type Request,
  type RoomAlias,
  type RoomInfo,
  type ServerFrame,
  type Welcome,
  type WorldState,
} from "./types.js";

export interface AgentOptions {
  token?: string;
  url?: string;
  reconnect?: boolean;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  requestTimeoutMs?: number;
  heartbeatMs?: number;
  rejoinLastRoom?: boolean;
  log?: (message: string) => void;
}

type Handler<E extends AgentEventName> = (data: AgentEvents[E]) => void;

interface Pending {
  frame: string;
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  retried: boolean;
}

const FATAL_CLOSE = new Set([4001, 4003, 4004]);
const STEP_MS = 350;

export class WinkilandAgent {
  readonly url: string;
  private readonly token: string;
  private readonly opts: Required<Omit<AgentOptions, "token" | "url" | "log">> & { log: (message: string) => void };
  private ws: WebSocket | null = null;
  private readonly handlers = new Map<AgentEventName, Set<Handler<AgentEventName>>>();
  private readonly pending = new Map<string, Pending>();
  private nonce = Math.random().toString(36).slice(2, 8);
  private seq = 0;
  private attempt = 0;
  private stopped = true;
  private heartbeat: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private firstConnect: { resolve: (w: Welcome) => void; reject: (e: Error) => void } | null = null;
  private lastRoom: string | null = null;

  welcome: Welcome | null = null;
  room: RoomInfo | null = null;
  selfId: string | null = null;
  readonly entities = new Map<string, Entity>();

  constructor(options: AgentOptions = {}) {
    const token = options.token ?? process.env.WINKILAND_AGENT_TOKEN;
    if (!token || !/^wk_agent_[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new WinkilandError("invalid_token", "Falta el token del agente (wk_agent_…). Pásalo en options.token o en WINKILAND_AGENT_TOKEN.");
    }
    this.token = token;
    this.url = options.url ?? process.env.WINKILAND_URL ?? DEFAULT_URL;
    if (!/^wss:\/\//.test(this.url) && !/^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(this.url)) {
      throw new WinkilandError("insecure_url", "Usa wss:// (ws:// solo para localhost).");
    }
    this.opts = {
      reconnect: options.reconnect ?? true,
      minBackoffMs: options.minBackoffMs ?? 1_000,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      requestTimeoutMs: options.requestTimeoutMs ?? 10_000,
      heartbeatMs: options.heartbeatMs ?? 25_000,
      rejoinLastRoom: options.rejoinLastRoom ?? true,
      log: options.log ?? (() => undefined),
    };
  }

  on<E extends AgentEventName>(event: E, handler: Handler<E>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<AgentEventName>);
    return () => set.delete(handler as Handler<AgentEventName>);
  }

  once<E extends AgentEventName>(event: E, handler: Handler<E>): () => void {
    const off = this.on(event, (data) => {
      off();
      handler(data);
    });
    return off;
  }

  waitFor<E extends AgentEventName>(event: E, predicate: (data: AgentEvents[E]) => boolean = () => true, timeoutMs = 30_000): Promise<AgentEvents[E]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new WinkilandError("timeout", `No llegó el evento ${event} a tiempo.`));
      }, timeoutMs);
      const off = this.on(event, (data) => {
        if (!predicate(data)) return;
        clearTimeout(timer);
        off();
        resolve(data);
      });
    });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.welcome !== null;
  }

  get self(): Entity | null {
    return this.selfId ? (this.entities.get(this.selfId) ?? null) : null;
  }

  connect(): Promise<Welcome> {
    if (this.connected && this.welcome) return Promise.resolve(this.welcome);
    if (this.firstConnect) return Promise.reject(new WinkilandError("connecting", "Ya hay una conexión en curso."));
    this.stopped = false;
    return new Promise((resolve, reject) => {
      this.firstConnect = { resolve, reject };
      this.open();
    });
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.stopHeartbeat();
    this.failPending(new WinkilandError("closed", "El agente se cerró."));
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
        ws.close(1000, "bye");
        setTimeout(resolve, 2_000).unref();
      });
    }
  }

  ping(): Promise<{ pong: true; at: number }> {
    return this.request({ type: "ping" }) as Promise<{ pong: true; at: number }>;
  }

  rooms(): Promise<Record<RoomAlias, string>> {
    return this.request({ type: "rooms" }) as Promise<Record<RoomAlias, string>>;
  }

  async join(room: RoomAlias | string): Promise<{ room: RoomInfo; self: Entity }> {
    const data = (await this.request({ type: "join", room })) as { room: RoomInfo; self: Entity };
    this.lastRoom = room;
    return data;
  }

  look(): Promise<WorldState> {
    return this.request({ type: "look" }) as Promise<WorldState>;
  }

  async moveTo(x: number, y: number, options: { wait?: boolean; timeoutMs?: number } = {}): Promise<{ x: number; y: number; arrived: boolean }> {
    await this.request({ type: "move", x, y });
    if (!options.wait) return { x, y, arrived: false };
    const me = this.self;
    if (me && me.x === x && me.y === y) return { x, y, arrived: true };
    const distance = me ? Math.abs(me.x - x) + Math.abs(me.y - y) : 40;
    try {
      await this.waitFor("move", (d) => d.moves.some((m) => m.id === this.selfId && m.x === x && m.y === y), options.timeoutMs ?? distance * STEP_MS * 3 + 3_000);
      return { x, y, arrived: true };
    } catch {
      return { x, y, arrived: false };
    }
  }

  say(text: string): Promise<{ sent: true }> {
    return this.request({ type: "say", text }) as Promise<{ sent: true }>;
  }

  sit(x: number, y: number): Promise<unknown> {
    return this.request({ type: "sit", x, y });
  }

  stand(): Promise<unknown> {
    return this.request({ type: "stand" });
  }

  emote(emote: Emote): Promise<unknown> {
    return this.request({ type: "emote", emote });
  }

  wave(target: string): Promise<unknown> {
    return this.request({ type: "social", target, action: "wave" });
  }

  highFive(target: string): Promise<unknown> {
    return this.request({ type: "social", target, action: "highfive" });
  }

  interact(target: Interactable): Promise<unknown> {
    return this.request({ type: "interact", target });
  }

  attack(target: string): Promise<{ target: string }> {
    return this.request({ type: "attack", target }) as Promise<{ target: string }>;
  }

  rentalReply(text: string): Promise<{ sent: true }> {
    return this.request({ type: "rental_reply", text }) as Promise<{ sent: true }>;
  }

  nearby(radius = 3): Entity[] {
    const me = this.self;
    if (!me) return [];
    return [...this.entities.values()].filter((e) => e.id !== me.id && Math.max(Math.abs(e.x - me.x), Math.abs(e.y - me.y)) <= radius);
  }

  request(req: Request): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.welcome) {
      return Promise.reject(new WinkilandError("not_connected", "El agente no está conectado."));
    }
    const id = `${this.nonce}-${++this.seq}`;
    const frame = JSON.stringify({ ...req, id });
    return new Promise((resolve, reject) => {
      const pending: Pending = { frame, resolve, reject, timer: setTimeout(() => this.onTimeout(id), this.opts.requestTimeoutMs), retried: false };
      this.pending.set(id, pending);
      ws.send(frame);
    });
  }

  private onTimeout(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    if (!p.retried && this.ws?.readyState === WebSocket.OPEN) {
      p.retried = true;
      p.timer = setTimeout(() => this.onTimeout(id), this.opts.requestTimeoutMs);
      this.ws.send(p.frame);
      return;
    }
    this.pending.delete(id);
    p.reject(new WinkilandError("timeout", "El servidor no respondió a tiempo."));
  }

  private open(): void {
    const ws = new WebSocket(this.url, { headers: { Authorization: `Bearer ${this.token}` }, handshakeTimeout: 10_000, maxPayload: 1 << 20 });
    this.ws = ws;
    ws.on("unexpected-response", (_req, res) => {
      const code = res.statusCode ?? 0;
      res.resume();
      if (code === 401 || code === 403) {
        this.fatal(code, code === 401 ? "Token inválido, revocado o suspendido." : "Conexión rechazada (¿desde un navegador?).");
        ws.terminate();
        return;
      }
      this.opts.log(`handshake rechazado: HTTP ${code}`);
      ws.terminate();
    });
    ws.on("message", (raw) => this.onFrame(raw.toString()));
    ws.on("close", (code, reason) => this.onClose(ws, code, reason.toString()));
    ws.on("error", (err) => this.opts.log(`error de conexión: ${err.message}`));
  }

  private onFrame(text: string): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(text) as ServerFrame;
    } catch {
      return;
    }
    if (frame.type === "welcome") {
      this.onWelcome(frame);
      return;
    }
    if (frame.type === "result") {
      const p = this.pending.get(frame.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(frame.id);
      if (frame.ok) p.resolve(frame.data);
      else p.reject(new WinkilandError(frame.error.code, frame.error.message));
      return;
    }
    if (frame.type === "event") this.onEvent(frame.event, frame.data);
  }

  private onWelcome(w: Welcome): void {
    const reconnect = this.welcome !== null;
    this.welcome = w;
    this.selfId = w.agent.entityId;
    this.room = null;
    this.entities.clear();
    this.attempt = 0;
    this.startHeartbeat();
    this.emit("welcome", w);
    this.emit("connected", w);
    const first = this.firstConnect;
    this.firstConnect = null;
    first?.resolve(w);
    if (reconnect && this.opts.rejoinLastRoom && this.lastRoom) {
      const room = this.lastRoom;
      this.join(room).catch((err: Error) => this.opts.log(`no se pudo volver a ${room}: ${err.message}`));
    }
  }

  private onEvent(name: string, data: unknown): void {
    switch (name) {
      case "room": {
        const d = data as AgentEvents["room"];
        this.room = d.room;
        this.selfId = d.selfId;
        this.entities.clear();
        for (const e of d.entities) this.entities.set(e.id, e);
        break;
      }
      case "spawn": {
        const d = data as AgentEvents["spawn"];
        this.entities.set(d.entity.id, d.entity);
        break;
      }
      case "despawn":
        this.entities.delete((data as AgentEvents["despawn"]).id);
        break;
      case "move":
        for (const m of (data as AgentEvents["move"]).moves) {
          const e = this.entities.get(m.id);
          if (e) {
            e.x = m.x;
            e.y = m.y;
            e.seated = false;
          }
        }
        break;
      case "seat": {
        const d = data as AgentEvents["seat"];
        const e = this.entities.get(d.id);
        if (e) {
          e.x = d.x;
          e.y = d.y;
          e.seated = d.seated;
        }
        break;
      }
      case "evicted":
        this.room = null;
        this.entities.clear();
        this.lastRoom = null;
        break;
    }
    this.emit(name as AgentEventName, data as never);
  }

  private onClose(ws: WebSocket, code: number, reason: string): void {
    if (this.ws !== ws) return;
    this.ws = null;
    this.stopHeartbeat();
    this.failPending(new WinkilandError("disconnected", "Se cortó la conexión antes de la respuesta."));
    if (FATAL_CLOSE.has(code)) {
      this.fatal(code, reason || "El servidor cerró la conexión de forma definitiva.");
      return;
    }
    const willReconnect = !this.stopped && this.opts.reconnect;
    this.emit("disconnected", { code, reason, willReconnect });
    if (!willReconnect) {
      this.firstConnect?.reject(new WinkilandError("disconnected", `Conexión cerrada (${code}).`));
      this.firstConnect = null;
      return;
    }
    this.attempt += 1;
    const base = Math.min(this.opts.maxBackoffMs, this.opts.minBackoffMs * 2 ** Math.min(this.attempt - 1, 10));
    const delayMs = Math.round(base * (0.5 + Math.random() / 2));
    this.emit("reconnecting", { attempt: this.attempt, delayMs, code });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.open();
    }, delayMs);
  }

  private fatal(code: number | string, reason: string): void {
    this.stopped = true;
    this.stopHeartbeat();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.emit("fatal", { code, reason });
    this.firstConnect?.reject(new WinkilandError(String(code), reason));
    this.firstConnect = null;
  }

  private failPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      const ws = this.ws;
      this.ping().catch(() => {
        if (this.ws === ws && ws) {
          this.opts.log("sin respuesta al ping; reconectando");
          ws.terminate();
        }
      });
    }, this.opts.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private emit<E extends AgentEventName>(event: E, data: AgentEvents[E]): void {
    for (const h of this.handlers.get(event) ?? []) {
      try {
        (h as Handler<E>)(data);
      } catch (err) {
        this.opts.log(`un handler de "${event}" falló: ${(err as Error).message}`);
      }
    }
  }
}

export type { ChatMessage };
