"""Authorization gates.

Each function raises :class:`AuthorizationError` on deny; the API/WS layer
maps that to HTTP 403 / WebSocket 4403.
"""

from __future__ import annotations

from collections.abc import Iterable

from .authn import JoinTokenPayload, ParticipantKindLiteral


class AuthorizationError(Exception):
    """Raised when a token is valid but not allowed to perform the action."""


def require_creator(token: JoinTokenPayload) -> None:
    """Allow only the creator role of the session bound to the token."""

    if token["kind"] != "creator":
        raise AuthorizationError("creator-only action")


def require_participant(token: JoinTokenPayload) -> None:
    """Allow any seated participant (creator/player). Spectators denied."""

    if token["kind"] not in ("creator", "player"):
        raise AuthorizationError("participant-only action")


def require_seated(token: JoinTokenPayload) -> None:
    """Allow ANY seated role on the session (creator / player / spectator).

    Used by self-only endpoints — those whose subject is unambiguously
    the role bound to the token (e.g. ``POST .../roles/me/display_name``).
    The token binding itself is the access control; spectators have a
    legitimate need to set their own display_name so peers see who's
    watching, and the action can't affect anyone else.
    """

    if token["kind"] not in ("creator", "player", "spectator"):
        raise AuthorizationError("token kind not recognized")


def require_active_role(
    token: JoinTokenPayload,
    *,
    active_role_ids: Iterable[str],
) -> None:
    """Allow only a role currently named in ``active_role_ids``."""

    if token["role_id"] not in set(active_role_ids):
        raise AuthorizationError("not your turn")


def kind_of(token: JoinTokenPayload) -> ParticipantKindLiteral:
    return token["kind"]
