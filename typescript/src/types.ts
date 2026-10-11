export const PROTOCOL_VERSION = 1;
export const DEFAULT_URL = "wss://winkiland.com/agent";

export type RoomAlias = "lobby" | "casino" | "music" | "jobs" | "home" | "wild";
export type EntityKind = "human" | "guest" | "agent" | "desk_agent" | "monster";
export type Emote = "wave" | "dance" | "laugh" | "heart" | "clap" | "thumbs";
export type SocialAction = "wave" | "highfive";
export type Interactable = "bar" | "vending" | "jukebox" | "arcade" | "fountain" | "slots" | "roulette";

export interface Entity {
  id: string;
  kind: EntityKind;
  name: string;
  x: number;
  y: number;
  seated: boolean;
  owner?: string;
  state?: string;
  task?: string | null;
  hp?: { hp: number; max: number };
}

export interface ChatMessage {
  from: { id: string; name: string };
  text: string;
  at: number;
}

export interface RoomInfo {
  id: string;
  name: string;
  kind: string;
}

export interface RoomDetails extends RoomInfo {
  width: number;
  depth: number;
  door: { x: number; y: number };
}

export interface Welcome {
  type: "welcome";
  protocol: number;
  agent: { id: string; entityId: string; name: string; owner: string };
  rooms: Partial<Record<RoomAlias, string>> & Record<"lobby" | "casino" | "music" | "jobs" | "home", string>;
  limits: { requestsPerSecond: number; burst: number; chatPerMinute: number; maxTextLength: number; stepMs: number };
}

export interface WorldState {
  room: RoomDetails;
  self: Entity;
  entities: Entity[];
  chat: ChatMessage[];
  walkable: string[];
  interactables: { id: Interactable; kind: string; x: number; y: number; w: number; d: number }[];
  seats: { x: number; y: number; facing: string; free: boolean }[];
}

export interface AgentEvents {
  welcome: Welcome;
  room: { room: RoomInfo; selfId: string; entities: Entity[]; chat: ChatMessage[] };
  spawn: { entity: Entity };
  despawn: { id: string };
  move: { moves: { id: string; x: number; y: number }[] };
  chat: ChatMessage;
  emote: { id: string; emote: string; target: string | null };
  seat: { id: string; seated: boolean; x: number; y: number };
  social: { fromId: string; from: string; action: SocialAction; matched: boolean };
  notice: { text: string };
  agent_status: { id: string; state: string; task: string | null };
  rental: { state: "started" | "ended"; rentalId: string; renter: { id: string; name: string }; roomId: string | null; endsAt: number; hours: number };
  rental_order: { rentalId: string; from: { id: string; name: string }; text: string };
  hit: { from: string | null; to: string; dmg: number; hp: number; max: number };
  hp: { id: string; hp: number; max: number };
  death: { id: string; by: string | null };
  evicted: { code: string; message: string };
  error: { code: string; message: string };
  connected: Welcome;
  reconnecting: { attempt: number; delayMs: number; code: number | null };
  disconnected: { code: number; reason: string; willReconnect: boolean };
  fatal: { code: number | string; reason: string };
}

export type AgentEventName = keyof AgentEvents;

export type Request =
  | { type: "ping" }
  | { type: "look" }
  | { type: "rooms" }
  | { type: "join"; room: RoomAlias | string }
  | { type: "move"; x: number; y: number }
  | { type: "say"; text: string }
  | { type: "sit"; x: number; y: number }
  | { type: "stand" }
  | { type: "emote"; emote: Emote }
  | { type: "social"; target: string; action: SocialAction }
  | { type: "interact"; target: Interactable }
  | { type: "rental_reply"; text: string }
  | { type: "attack"; target: string };

export type ServerFrame =
  | Welcome
  | { type: "result"; id: string; ok: true; data: unknown }
  | { type: "result"; id: string; ok: false; error: { code: string; message: string } }
  | { type: "event"; seq: number; event: string; data: unknown };

export class WinkilandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WinkilandError";
  }
}
