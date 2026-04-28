"""HMAC-signed join-token authentication.

The MVP authentication primitive is an `itsdangerous`-signed token bound to a
``(session_id, role_id, kind)`` tuple. Pluggable behind the
:class:`Authenticator` Protocol so OAuth/SSO can drop in later without
touching call sites.
"""

from __future__ import annotations

from typing import Literal, Protocol, TypedDict

from itsdangerous import BadSignature, URLSafeSerializer

ParticipantKindLiteral = Literal["creator", "player", "spectator"]


class JoinTokenPayload(TypedDict):
    session_id: str
    role_id: str
    kind: ParticipantKindLiteral


class InvalidTokenError(Exception):
    """Raised when a token fails to verify."""


class Authenticator(Protocol):
    """Mints and verifies role join tokens."""

    def mint(self, *, session_id: str, role_id: str, kind: ParticipantKindLiteral) -> str:
        ...

    def verify(self, token: str) -> JoinTokenPayload:
        ...


class HMACAuthenticator:
    """Signed-token authenticator backed by `itsdangerous.URLSafeSerializer`.

    The serializer uses HMAC-SHA1 over a JSON-encoded payload by default,
    which is sufficient for non-confidential tamper-evidence (the payload is
    not secret — the session/role ids round-trip in plaintext via the token).
    """

    _SALT = "atf.join-token.v1"

    def __init__(self, secret: str) -> None:
        if not secret or len(secret) < 16:
            raise ValueError("SESSION_SECRET must be at least 16 characters / bytes")
        self._serializer = URLSafeSerializer(secret_key=secret, salt=self._SALT)

    def mint(self, *, session_id: str, role_id: str, kind: ParticipantKindLiteral) -> str:
        payload: JoinTokenPayload = {
            "session_id": session_id,
            "role_id": role_id,
            "kind": kind,
        }
        return self._serializer.dumps(payload)

    def verify(self, token: str) -> JoinTokenPayload:
        try:
            data = self._serializer.loads(token)
        except BadSignature as exc:
            raise InvalidTokenError("token signature invalid") from exc
        if not isinstance(data, dict):
            raise InvalidTokenError("token payload malformed")
        for key in ("session_id", "role_id", "kind"):
            if key not in data or not isinstance(data[key], str):
                raise InvalidTokenError(f"token missing field: {key}")
        if data["kind"] not in ("creator", "player", "spectator"):
            raise InvalidTokenError(f"unknown participant kind: {data['kind']}")
        return JoinTokenPayload(
            session_id=data["session_id"],
            role_id=data["role_id"],
            kind=data["kind"],
        )
