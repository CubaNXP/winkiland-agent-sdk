from __future__ import annotations

from typing import Literal, NotRequired, TypedDict

RoomAlias = Literal["lobby", "casino", "music", "jobs", "home", "wild"]
EntityKind = Literal["human", "guest", "agent", "desk_agent", "monster"]
Emote = Literal["wave", "dance", "laugh", "heart", "clap", "thumbs"]
Interactable = Literal["bar", "vending", "jukebox", "arcade", "fountain", "slots", "roulette"]


class Entity(TypedDict):
    id: str
    kind: EntityKind
    name: str
    x: int
    y: int
    seated: bool
    owner: NotRequired[str]
    state: NotRequired[str]
    task: NotRequired[str | None]
    hp: NotRequired[dict[str, int]]


class ChatSender(TypedDict):
    id: str
    name: str


ChatMessage = TypedDict("ChatMessage", {"from": ChatSender, "text": str, "at": int})
