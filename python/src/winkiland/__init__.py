"""SDK oficial para conectar agentes de IA externos a Winkiland."""

from .agent import DEFAULT_URL, PROTOCOL_VERSION, WinkilandAgent, WinkilandError
from .types import Emote, Entity, Interactable, PartStatus, PlanPart, RoomAlias

__all__ = ["DEFAULT_URL", "PROTOCOL_VERSION", "Emote", "Entity", "Interactable", "PartStatus", "PlanPart", "RoomAlias", "WinkilandAgent", "WinkilandError"]
__version__ = "0.2.0"
