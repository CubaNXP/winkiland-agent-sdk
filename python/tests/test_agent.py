import asyncio
import json
import unittest
from typing import Any

from websockets.asyncio.server import ServerConnection, serve
from websockets.datastructures import Headers
from websockets.http11 import Response

from winkiland import WinkilandAgent, WinkilandError

TOKEN = "wk_agent_" + "a" * 43

WELCOME = {
    "type": "welcome",
    "protocol": 1,
    "agent": {"id": "a1", "entityId": "x:a1", "name": "Test", "owner": "dueno"},
    "rooms": {"lobby": "L", "casino": "C", "music": "M", "jobs": "J", "home": "H"},
    "limits": {"requestsPerSecond": 8, "burst": 20, "chatPerMinute": 48, "maxTextLength": 200, "stepMs": 350},
}

ROOM_EVENT = {
    "type": "event",
    "seq": 1,
    "event": "room",
    "data": {
        "room": {"id": "L", "name": "Lobby", "kind": "lobby"},
        "selfId": "x:a1",
        "entities": [
            {"id": "x:a1", "kind": "agent", "name": "Test", "x": 0, "y": 1, "seated": False},
            {"id": "u:1", "kind": "human", "name": "ana", "x": 1, "y": 1, "seated": False},
        ],
        "chat": [],
    },
}


class Fake:
    def __init__(self, status: int | None = None) -> None:
        self.status = status
        self.frames: list[dict[str, Any]] = []
        self.sockets: list[ServerConnection] = []
        self.mode = "normal"
        self.moves_seen = 0
        self.server: Any = None
        self.url = ""

    async def start(self) -> None:
        def process_request(connection: ServerConnection, request: Any) -> Response | None:
            if self.status:
                return connection.respond(self.status, "nope\n")
            assert request.headers["Authorization"] == f"Bearer {TOKEN}"
            return None

        self.server = await serve(self.handler, "127.0.0.1", 0, process_request=process_request)
        port = self.server.sockets[0].getsockname()[1]
        self.url = f"ws://127.0.0.1:{port}/agent"

    async def handler(self, ws: ServerConnection) -> None:
        self.sockets.append(ws)
        await ws.send(json.dumps(WELCOME))
        async for raw in ws:
            req = json.loads(raw)
            self.frames.append(req)
            if req["type"] == "join":
                await ws.send(json.dumps(ROOM_EVENT))
                await ws.send(json.dumps({"type": "result", "id": req["id"], "ok": True, "data": {"room": {"kind": "lobby"}}}))
            elif req["type"] == "move" and self.mode == "late":
                self.moves_seen += 1
                if self.moves_seen == 2:
                    await ws.send(json.dumps({"type": "result", "id": req["id"], "ok": True, "data": {}}))
            else:
                await ws.send(json.dumps({"type": "result", "id": req["id"], "ok": True, "data": {"echo": req["type"]}}))

    async def stop(self) -> None:
        self.server.close()
        await self.server.wait_closed()


class AgentTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.fake = Fake()
        await self.fake.start()

    async def asyncTearDown(self) -> None:
        await self.fake.stop()

    def test_rejects_bad_token_and_insecure_url(self) -> None:
        with self.assertRaises(WinkilandError):
            WinkilandAgent(token="nope")
        with self.assertRaises(WinkilandError):
            WinkilandAgent(token=TOKEN, url="ws://example.com/agent")

    async def test_connects_joins_and_tracks_entities(self) -> None:
        agent = WinkilandAgent(token=TOKEN, url=self.fake.url)
        welcome = await agent.connect()
        self.assertEqual(welcome["agent"]["name"], "Test")
        await agent.join("lobby")
        self.assertEqual(agent.world.room, {"id": "L", "name": "Lobby", "kind": "lobby"})
        self.assertEqual([e["name"] for e in agent.nearby(2)], ["ana"])
        self.assertEqual(await agent.say("hola"), {"echo": "say"})
        self.assertEqual(self.fake.frames[-1]["text"], "hola")
        await agent.close()

    async def test_async_handlers_can_send_without_deadlock(self) -> None:
        agent = WinkilandAgent(token=TOKEN, url=self.fake.url, request_timeout=1)
        got: list[Any] = []

        @agent.on("room")
        async def on_room(_: dict[str, Any]) -> None:
            got.append(await agent.say("desde handler"))

        await agent.connect()
        await agent.join("lobby")
        for _ in range(50):
            if got:
                break
            await asyncio.sleep(0.02)
        self.assertEqual(got, [{"echo": "say"}])
        await agent.close()

    async def test_resends_same_id_when_late(self) -> None:
        self.fake.mode = "late"
        agent = WinkilandAgent(token=TOKEN, url=self.fake.url, request_timeout=0.2)
        await agent.connect()
        await agent.move_to(3, 4)
        moves = [f for f in self.fake.frames if f["type"] == "move"]
        self.assertEqual(len(moves), 2)
        self.assertEqual(moves[0]["id"], moves[1]["id"])
        await agent.close()

    async def test_reconnects_and_rejoins(self) -> None:
        agent = WinkilandAgent(token=TOKEN, url=self.fake.url, min_backoff=0.05, max_backoff=0.1)
        events: list[str] = []
        agent.on("reconnecting", lambda d: events.append("reconnecting"))
        agent.on("connected", lambda d: events.append("connected"))
        await agent.connect()
        await agent.join("casino")
        await self.fake.sockets[0].close(1011, "boom")
        await agent.wait_for("room", timeout=3)
        await asyncio.sleep(0.05)
        self.assertEqual([f["room"] for f in self.fake.frames if f["type"] == "join"], ["casino", "casino"])
        self.assertEqual(events, ["connected", "reconnecting", "connected"])
        await agent.close()

    async def test_stops_when_revoked(self) -> None:
        agent = WinkilandAgent(token=TOKEN, url=self.fake.url, min_backoff=0.02)
        await agent.connect()
        await self.fake.sockets[0].close(4003, "revoked")
        with self.assertRaises(WinkilandError) as ctx:
            await asyncio.wait_for(agent.run_forever(), 3)
        self.assertEqual(ctx.exception.code, "4003")
        self.assertEqual(len(self.fake.sockets), 1)
        with self.assertRaises(WinkilandError):
            await agent.say("hola")


class RejectedTests(unittest.IsolatedAsyncioTestCase):
    async def test_401_fails_connect(self) -> None:
        fake = Fake(status=401)
        await fake.start()
        try:
            agent = WinkilandAgent(token=TOKEN, url=fake.url, min_backoff=0.02)
            with self.assertRaises(WinkilandError) as ctx:
                await asyncio.wait_for(agent.connect(), 3)
            self.assertEqual(ctx.exception.code, "401")
        finally:
            await fake.stop()


if __name__ == "__main__":
    unittest.main()
