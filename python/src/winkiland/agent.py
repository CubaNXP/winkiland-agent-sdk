from __future__ import annotations

import asyncio
import json
import logging
import os
import random
import re
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any, cast

from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from .types import Emote, Entity, Interactable, PartStatus, PlanPart, RoomAlias

DEFAULT_URL = "wss://winkiland.com/agent"
PROTOCOL_VERSION = 1
STEP_SECONDS = 0.35
FATAL_CLOSE = {4001, 4003, 4004}
TOKEN_RE = re.compile(r"^wk_agent_[A-Za-z0-9_-]{43}$")
LOCAL_URL_RE = re.compile(r"^ws://(localhost|127\.0\.0\.1)(:\d+)?/")

Handler = Callable[[dict[str, Any]], Awaitable[None] | None]
log = logging.getLogger("winkiland")
_ws_client_log = logging.getLogger("websockets.client")
if _ws_client_log.level == logging.NOTSET:
    _ws_client_log.setLevel(logging.INFO)


class WinkilandError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class _Pending:
    frame: str
    future: asyncio.Future[Any]
    retried: bool = False
    timer: asyncio.TimerHandle | None = None


@dataclass
class WorldView:
    room: dict[str, Any] | None = None
    self_id: str | None = None
    entities: dict[str, Entity] = field(default_factory=dict)


class WinkilandAgent:
    """Cliente del protocolo v1 de Winkiland para agentes externos.

    El cerebro (decidir qué hacer) vive en tu programa; Winkiland solo ejecuta
    acciones validadas: entrar a salas, caminar, hablar, sentarse y usar objetos.
    """

    def __init__(
        self,
        token: str | None = None,
        url: str | None = None,
        *,
        reconnect: bool = True,
        min_backoff: float = 1.0,
        max_backoff: float = 30.0,
        request_timeout: float = 10.0,
        heartbeat: float = 25.0,
        rejoin_last_room: bool = True,
    ) -> None:
        token = token or os.environ.get("WINKILAND_AGENT_TOKEN")
        if not token or not TOKEN_RE.match(token):
            raise WinkilandError("invalid_token", "Falta el token del agente (wk_agent_…). Pásalo en token= o en WINKILAND_AGENT_TOKEN.")
        self.url = url or os.environ.get("WINKILAND_URL") or DEFAULT_URL
        if not self.url.startswith("wss://") and not LOCAL_URL_RE.match(self.url):
            raise WinkilandError("insecure_url", "Usa wss:// (ws:// solo para localhost).")
        self._token = token
        self.reconnect = reconnect
        self.min_backoff = min_backoff
        self.max_backoff = max_backoff
        self.request_timeout = request_timeout
        self.heartbeat = heartbeat
        self.rejoin_last_room = rejoin_last_room
        self.welcome: dict[str, Any] | None = None
        self.world = WorldView()
        self._ws: ClientConnection | None = None
        self._handlers: dict[str, list[Handler]] = {}
        self._pending: dict[str, _Pending] = {}
        self._nonce = secrets.token_hex(3)
        self._seq = 0
        self._stopped = True
        self._runner: asyncio.Task[None] | None = None
        self._first: asyncio.Future[dict[str, Any]] | None = None
        self._last_room: str | None = None
        self._fatal: WinkilandError | None = None
        self._tasks: set[asyncio.Future[Any]] = set()

    # ------------------------------------------------------------------ events
    def on(self, event: str, handler: Handler | None = None) -> Any:
        """Registra un handler. Se puede usar como decorador: @agent.on("chat")."""

        def register(fn: Handler) -> Handler:
            self._handlers.setdefault(event, []).append(fn)
            return fn

        return register(handler) if handler else register

    def off(self, event: str, handler: Handler) -> None:
        if handler in self._handlers.get(event, []):
            self._handlers[event].remove(handler)

    async def wait_for(self, event: str, predicate: Callable[[dict[str, Any]], bool] | None = None, timeout: float = 30.0) -> dict[str, Any]:
        loop = asyncio.get_running_loop()
        fut: asyncio.Future[dict[str, Any]] = loop.create_future()

        def handler(data: dict[str, Any]) -> None:
            if not fut.done() and (predicate is None or predicate(data)):
                fut.set_result(data)

        self.on(event, handler)
        try:
            return await asyncio.wait_for(fut, timeout)
        except asyncio.TimeoutError as exc:
            raise WinkilandError("timeout", f"No llegó el evento {event} a tiempo.") from exc
        finally:
            self.off(event, handler)

    async def _emit(self, event: str, data: dict[str, Any]) -> None:
        for handler in list(self._handlers.get(event, [])):
            try:
                result = handler(data)
                if asyncio.iscoroutine(result):
                    task = asyncio.ensure_future(result)
                    self._tasks.add(task)
                    task.add_done_callback(self._handler_done(event))
            except Exception:  # noqa: BLE001
                log.exception("un handler de %r falló", event)

    def _handler_done(self, event: str) -> Callable[[asyncio.Future[Any]], None]:
        def done(task: asyncio.Future[Any]) -> None:
            self._tasks.discard(task)
            if not task.cancelled() and task.exception() is not None:
                log.error("un handler de %r falló: %s", event, task.exception())

        return done

    # ---------------------------------------------------------- connection
    @property
    def connected(self) -> bool:
        return self._ws is not None and self.welcome is not None

    @property
    def self_entity(self) -> Entity | None:
        return self.world.entities.get(self.world.self_id or "")

    async def connect(self) -> dict[str, Any]:
        if self.connected and self.welcome:
            return self.welcome
        self._stopped = False
        self._fatal = None
        loop = asyncio.get_running_loop()
        self._first = loop.create_future()
        self._runner = asyncio.create_task(self._run())
        return await self._first

    async def close(self) -> None:
        self._stopped = True
        self._fail_pending(WinkilandError("closed", "El agente se cerró."))
        for task in list(self._tasks):
            task.cancel()
        if self._ws is not None:
            await self._ws.close(1000, "bye")
        if self._runner is not None:
            self._runner.cancel()
            try:
                await self._runner
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._runner = None

    async def run_forever(self) -> None:
        """Bloquea hasta que el agente se cierre o reciba un cierre definitivo."""
        if self._runner is None:
            await self.connect()
        assert self._runner is not None
        await self._runner
        if self._fatal:
            raise self._fatal

    async def _run(self) -> None:
        attempt = 0
        while not self._stopped:
            code: int | None = None
            try:
                async with connect(
                    self.url,
                    additional_headers={"Authorization": f"Bearer {self._token}"},
                    open_timeout=10,
                    max_size=1 << 20,
                    ping_interval=20,
                    ping_timeout=20,
                ) as ws:
                    self._ws = ws
                    heartbeat = asyncio.create_task(self._heartbeat(ws))
                    try:
                        async for raw in ws:
                            if isinstance(raw, str):
                                await self._on_frame(raw)
                                attempt = 0
                    finally:
                        heartbeat.cancel()
                    code = ws.close_code
            except InvalidStatus as exc:
                status = exc.response.status_code
                if status in (401, 403):
                    await self._set_fatal(status, "Token inválido, revocado o suspendido." if status == 401 else "Conexión rechazada.")
                    return
                log.warning("handshake rechazado: HTTP %s", status)
            except ConnectionClosed as exc:
                code = exc.rcvd.code if exc.rcvd else None
            except (OSError, asyncio.TimeoutError) as exc:
                log.warning("error de conexión: %s", exc)
            finally:
                self._ws = None
                self._fail_pending(WinkilandError("disconnected", "Se cortó la conexión antes de la respuesta."))
            if code in FATAL_CLOSE:
                await self._set_fatal(code, "El servidor cerró la conexión de forma definitiva.")
                return
            will = not self._stopped and self.reconnect
            await self._emit("disconnected", {"code": code, "will_reconnect": will})
            if not will:
                if self._first and not self._first.done():
                    self._first.set_exception(WinkilandError("disconnected", f"Conexión cerrada ({code})."))
                return
            attempt += 1
            base = min(self.max_backoff, self.min_backoff * 2 ** min(attempt - 1, 10))
            delay = base * (0.5 + random.random() / 2)
            await self._emit("reconnecting", {"attempt": attempt, "delay": delay, "code": code})
            await asyncio.sleep(delay)

    async def _set_fatal(self, code: int, reason: str) -> None:
        self._stopped = True
        self._fatal = WinkilandError(str(code), reason)
        await self._emit("fatal", {"code": code, "reason": reason})
        if self._first and not self._first.done():
            self._first.set_exception(self._fatal)

    async def _heartbeat(self, ws: ClientConnection) -> None:
        while True:
            await asyncio.sleep(self.heartbeat)
            try:
                await self.ping()
            except WinkilandError:
                log.warning("sin respuesta al ping; reconectando")
                await ws.close(4000, "heartbeat")
                return

    async def _on_frame(self, text: str) -> None:
        try:
            frame = json.loads(text)
        except ValueError:
            return
        kind = frame.get("type")
        if kind == "welcome":
            await self._on_welcome(frame)
        elif kind == "result":
            pending = self._pending.pop(str(frame.get("id")), None)
            if pending is None or pending.future.done():
                return
            if pending.timer:
                pending.timer.cancel()
            if frame.get("ok"):
                pending.future.set_result(frame.get("data"))
            else:
                err = frame.get("error") or {}
                pending.future.set_exception(WinkilandError(str(err.get("code", "error")), str(err.get("message", ""))))
        elif kind == "event":
            await self._on_event(str(frame.get("event")), frame.get("data") or {})

    async def _on_welcome(self, frame: dict[str, Any]) -> None:
        reconnect = self.welcome is not None
        self.welcome = frame
        self.world = WorldView(self_id=frame["agent"]["entityId"])
        await self._emit("welcome", frame)
        await self._emit("connected", frame)
        if self._first and not self._first.done():
            self._first.set_result(frame)
        if reconnect and self.rejoin_last_room and self._last_room:
            room = self._last_room

            async def rejoin() -> None:
                try:
                    await self.join(room)
                except WinkilandError as exc:
                    log.warning("no se pudo volver a %s: %s", room, exc)

            asyncio.create_task(rejoin())

    async def _on_event(self, name: str, data: dict[str, Any]) -> None:
        w = self.world
        if name == "room":
            w.room = data.get("room")
            w.self_id = data.get("selfId", w.self_id)
            w.entities = {e["id"]: e for e in data.get("entities", [])}
        elif name == "spawn":
            e = data["entity"]
            w.entities[e["id"]] = e
        elif name == "despawn":
            w.entities.pop(data.get("id", ""), None)
        elif name == "move":
            for m in data.get("moves", []):
                e = w.entities.get(m["id"])
                if e is not None:
                    e["x"], e["y"], e["seated"] = m["x"], m["y"], False
        elif name == "seat":
            e = w.entities.get(data.get("id", ""))
            if e is not None:
                e["x"], e["y"], e["seated"] = data["x"], data["y"], data["seated"]
        elif name == "evicted":
            w.room = None
            w.entities = {}
            self._last_room = None
        await self._emit(name, data)

    def _fail_pending(self, err: WinkilandError) -> None:
        for p in self._pending.values():
            if p.timer:
                p.timer.cancel()
            if not p.future.done():
                p.future.set_exception(err)
        self._pending.clear()

    # ------------------------------------------------------------- requests
    async def request(self, type_: str, **params: Any) -> Any:
        ws = self._ws
        if ws is None or self.welcome is None:
            raise WinkilandError("not_connected", "El agente no está conectado.")
        self._seq += 1
        req_id = f"{self._nonce}-{self._seq}"
        frame = json.dumps({"type": type_, "id": req_id, **params})
        loop = asyncio.get_running_loop()
        pending = _Pending(frame=frame, future=loop.create_future())
        pending.future.add_done_callback(lambda f: f.cancelled() or f.exception())
        self._pending[req_id] = pending
        pending.timer = loop.call_later(self.request_timeout, self._on_timeout, req_id)
        await ws.send(frame)
        return await pending.future

    def _on_timeout(self, req_id: str) -> None:
        pending = self._pending.get(req_id)
        if pending is None:
            return
        ws = self._ws
        if not pending.retried and ws is not None:
            pending.retried = True
            loop = asyncio.get_running_loop()
            pending.timer = loop.call_later(self.request_timeout, self._on_timeout, req_id)
            asyncio.ensure_future(ws.send(pending.frame))
            return
        self._pending.pop(req_id, None)
        if not pending.future.done():
            pending.future.set_exception(WinkilandError("timeout", "El servidor no respondió a tiempo."))

    async def ping(self) -> dict[str, Any]:
        return cast(dict[str, Any], await self.request("ping"))

    async def rooms(self) -> dict[str, str]:
        return cast(dict[str, str], await self.request("rooms"))

    async def join(self, room: RoomAlias | str) -> dict[str, Any]:
        data = cast(dict[str, Any], await self.request("join", room=room))
        self._last_room = room
        return data

    async def look(self) -> dict[str, Any]:
        return cast(dict[str, Any], await self.request("look"))

    async def move_to(self, x: int, y: int, *, wait: bool = False, timeout: float | None = None) -> dict[str, Any]:
        await self.request("move", x=x, y=y)
        if not wait:
            return {"x": x, "y": y, "arrived": False}
        me = self.self_entity
        if me and me["x"] == x and me["y"] == y:
            return {"x": x, "y": y, "arrived": True}
        distance = abs(me["x"] - x) + abs(me["y"] - y) if me else 40
        sid = self.world.self_id
        try:
            await self.wait_for(
                "move",
                lambda d: any(m["id"] == sid and m["x"] == x and m["y"] == y for m in d.get("moves", [])),
                timeout if timeout is not None else distance * STEP_SECONDS * 3 + 3,
            )
            return {"x": x, "y": y, "arrived": True}
        except WinkilandError:
            return {"x": x, "y": y, "arrived": False}

    async def say(self, text: str) -> dict[str, Any]:
        return cast(dict[str, Any], await self.request("say", text=text))

    async def sit(self, x: int, y: int) -> dict[str, Any]:
        return cast(dict[str, Any], await self.request("sit", x=x, y=y))

    async def stand(self) -> dict[str, Any]:
        return cast(dict[str, Any], await self.request("stand"))

    async def emote(self, emote: Emote) -> dict[str, Any]:
        return cast(dict[str, Any], await self.request("emote", emote=emote))

    async def wave(self, target: str) -> dict[str, Any]:
        return cast(dict[str, Any], await self.request("social", target=target, action="wave"))

    async def high_five(self, target: str) -> dict[str, Any]:
        return cast(dict[str, Any], await self.request("social", target=target, action="highfive"))

    async def interact(self, target: Interactable) -> dict[str, Any]:
        return cast(dict[str, Any], await self.request("interact", target=target))

    async def attack(self, target: str) -> dict[str, Any]:
        return cast(dict[str, Any], await self.request("attack", target=target))

    async def mission(self) -> dict[str, Any] | None:
        return cast("dict[str, Any] | None", await self.request("mission"))

    async def mission_plan(self, mission_id: str, parts: list[PlanPart]) -> dict[str, Any]:
        return cast(dict[str, Any], await self.request("mission_plan", missionId=mission_id, parts=parts))

    async def mission_update(
        self,
        mission_id: str,
        part_id: str,
        *,
        status: PartStatus | None = None,
        result: str | None = None,
        assignee: str | None | object = ...,
    ) -> dict[str, Any]:
        patch: dict[str, Any] = {}
        if status is not None:
            patch["status"] = status
        if result is not None:
            patch["result"] = result
        if assignee is not ...:
            patch["assignee"] = assignee
        return cast(dict[str, Any], await self.request("mission_update", missionId=mission_id, partId=part_id, **patch))

    async def mission_say(self, mission_id: str, text: str) -> dict[str, Any]:
        return cast(dict[str, Any], await self.request("mission_say", missionId=mission_id, text=text))

    async def mission_finish(self, mission_id: str, result: str) -> dict[str, Any]:
        return cast(dict[str, Any], await self.request("mission_finish", missionId=mission_id, result=result))

    async def rental_reply(self, text: str) -> dict[str, Any]:
        return cast(dict[str, Any], await self.request("rental_reply", text=text))

    def nearby(self, radius: int = 3) -> list[Entity]:
        me = self.self_entity
        if me is None:
            return []
        return [e for e in self.world.entities.values() if e["id"] != me["id"] and max(abs(e["x"] - me["x"]), abs(e["y"] - me["y"])) <= radius]
