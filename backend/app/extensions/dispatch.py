"""Sandboxed extension-tool dispatcher.

Two handler kinds:
* ``static_text`` — return ``handler_config`` verbatim.
* ``templated_text`` — render ``handler_config`` as a Jinja template using a
  *minimal*, intentionally PII-free session context.

Critically, the dispatcher returns a ``tool_result``-shaped string. The
caller (LLM ToolDispatcher) wraps that in a ``tool_result`` content block —
extension content **never** flows into the system prompt.
"""

from __future__ import annotations

from typing import Any

from jinja2.exceptions import SecurityError, TemplateSyntaxError, UndefinedError
from jinja2.sandbox import SandboxedEnvironment

from ..auth.audit import AuditEvent, AuditLog
from ..logging_setup import get_logger
from .models import ExtensionTool
from .registry import FrozenRegistry

_logger = get_logger("extensions.dispatch")


class ExtensionDispatchError(RuntimeError):
    """Raised when dispatch fails — surfaced to Claude as a `tool_result` error."""


class ExtensionDispatcher:
    def __init__(
        self,
        *,
        registry: FrozenRegistry,
        max_template_bytes: int = 8192,
        audit: AuditLog,
    ) -> None:
        self._registry = registry
        self._max_template_bytes = max_template_bytes
        self._audit = audit
        self._env = SandboxedEnvironment(
            autoescape=False,
            extensions=[],
            keep_trailing_newline=False,
        )
        # Strip filters that can leak Python-internals (Jinja2 ships them, the
        # sandbox blocks attribute access but be belt-and-braces).
        for unsafe in ("tojson", "filesizeformat", "pprint"):
            self._env.filters.pop(unsafe, None)

    def list_tool_specs(self) -> list[dict[str, Any]]:
        """Anthropic-API-shaped tool definitions for registered extensions."""

        return [
            {
                "name": t.name,
                "description": t.description,
                "input_schema": t.input_schema,
            }
            for t in self._registry.tools.values()
        ]

    def lookup_resource(self, name: str) -> str:
        if name not in self._registry.resources:
            raise ExtensionDispatchError(f"resource not registered: {name}")
        return self._registry.resources[name].content

    def invoke(
        self,
        *,
        name: str,
        args: dict[str, Any],
        session_ctx: dict[str, Any],
        session_id: str,
        turn_id: str | None,
    ) -> str:
        tool = self._registry.tools.get(name)
        if tool is None:
            raise ExtensionDispatchError(f"extension tool not registered: {name}")

        self._validate_args(tool, args)

        try:
            result = self._dispatch(tool, args, session_ctx)
        except (SecurityError, UndefinedError, TemplateSyntaxError) as exc:
            self._audit.emit(
                AuditEvent(
                    kind="extension_dispatch_failed",
                    session_id=session_id,
                    turn_id=turn_id,
                    payload={"tool": name, "reason": str(exc)},
                )
            )
            raise ExtensionDispatchError(
                f"extension '{name}' template rejected: {exc}"
            ) from exc

        self._audit.emit(
            AuditEvent(
                kind="extension_invoked",
                session_id=session_id,
                turn_id=turn_id,
                payload={
                    "tool": name,
                    "args_keys": sorted(args.keys()),
                    "result_bytes": len(result),
                },
            )
        )
        return result

    # ----------------------------------------------------------- internals
    def _validate_args(self, tool: ExtensionTool, args: dict[str, Any]) -> None:
        # Lightweight schema check: required keys present, no obvious type errors.
        # We avoid a full JSONSchema dependency in MVP by handling the common
        # ``object`` shape with ``required`` and ``properties.<name>.type``.
        schema = tool.input_schema or {}
        required = schema.get("required") or []
        for key in required:
            if key not in args:
                raise ExtensionDispatchError(
                    f"missing required argument '{key}' for tool '{tool.name}'"
                )
        properties = schema.get("properties") or {}
        for key, value in args.items():
            spec = properties.get(key)
            if not spec:
                continue
            expected = spec.get("type")
            if expected and not _matches_type(value, expected):
                raise ExtensionDispatchError(
                    f"argument '{key}' has wrong type for tool '{tool.name}': "
                    f"expected {expected}"
                )

    def _dispatch(
        self,
        tool: ExtensionTool,
        args: dict[str, Any],
        session_ctx: dict[str, Any],
    ) -> str:
        if tool.handler_kind == "static_text":
            return tool.handler_config
        if tool.handler_kind == "templated_text":
            if len(tool.handler_config.encode("utf-8")) > self._max_template_bytes:
                raise ExtensionDispatchError(
                    f"template too large for tool '{tool.name}'"
                )
            template = self._env.from_string(tool.handler_config)
            return template.render(args=args, session=session_ctx)
        raise ExtensionDispatchError(f"unknown handler_kind: {tool.handler_kind}")


def _matches_type(value: Any, expected: str) -> bool:
    if expected == "string":
        return isinstance(value, str)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "array":
        return isinstance(value, list)
    if expected == "object":
        return isinstance(value, dict)
    return True
