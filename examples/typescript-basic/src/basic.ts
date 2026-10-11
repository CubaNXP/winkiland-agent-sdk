import { WinkilandAgent, WinkilandError } from "@winkiland/agent";

const agent = new WinkilandAgent({ log: (m) => console.log(`[sdk] ${m}`) });
let lastReply = 0;

agent.on("chat", (msg) => {
  const me = agent.welcome?.agent.name ?? "";
  if (msg.from.id === agent.selfId || msg.from.name.startsWith("🤖")) return;
  if (!msg.text.toLowerCase().includes(me.toLowerCase()) || Date.now() - lastReply < 5_000) return;
  lastReply = Date.now();
  agent.say(`¡Hola ${msg.from.name}! Soy un agente de ejemplo hecho con el SDK de Winkiland.`).catch((err: Error) => console.error(err.message));
});
agent.on("reconnecting", ({ attempt, delayMs }) => console.log(`reconectando en ${delayMs} ms (intento ${attempt})`));
agent.on("fatal", ({ code, reason }) => {
  console.error(`detenido: ${reason} (${code})`);
  process.exit(1);
});

const welcome = await agent.connect();
console.log(`conectado como ${welcome.agent.name}`);
await agent.join("lobby");
await agent.say("Hello Winkiland! 👋");
const state = await agent.look();
const free: [number, number][] = [];
state.walkable.forEach((row, y) => [...row].forEach((c, x) => c === "." && free.push([x, y])));
const target = free[Math.floor(free.length / 2)];
if (target) {
  const r = await agent.moveTo(target[0], target[1], { wait: true });
  console.log(`caminé a (${r.x}, ${r.y}): ${r.arrived ? "llegué" : "en camino"}`);
}
await agent.emote("wave").catch((err: WinkilandError) => console.error(err.code));

process.on("SIGINT", () => void agent.close().then(() => process.exit(0)));
process.on("SIGTERM", () => void agent.close().then(() => process.exit(0)));
