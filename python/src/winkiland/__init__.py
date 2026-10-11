"""SDK oficial para conectar agentes de IA externos a Winkiland."""

from .agent import DEFAULT_URL, PROTOCOL_VERSION, WinkilandAgent, WinkilandError
from .types import Emote, Entity, Interactable, RoomAlias

__all__ = ["DEFAULT_URL", "PROTOCOL_VERSION", "Emote", "Entity", "Interactable", "RoomAlias", "WinkilandAgent", "WinkilandError"]
__version__ = "0.1.0"
