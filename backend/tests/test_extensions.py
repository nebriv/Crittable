from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from app.auth.audit import AuditLog
from app.config import Settings
from app.extensions.dispatch import ExtensionDispatcher, ExtensionDispatchError
from app.extensions.loaders.env import EnvLoader
from app.extensions.models import (
    ExtensionBundle,
    ExtensionPrompt,
    ExtensionResource,
    ExtensionTool,
)
from app.extensions.registry import RegistrationError, freeze_bundle


def _settings_with(monkeypatch, **env: str) -> Settings:
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    return Settings()


def test_freeze_rejects_builtin_collision() -> None:
    bundle = ExtensionBundle(
        tools=[
            ExtensionTool(
                name="end_session",
                description="x",
                input_schema={"type": "object", "properties": {}},
                handler_kind="static_text",
                handler_config="hi",
            )
        ]
    )
    with pytest.raises(RegistrationError, match="collides"):
        freeze_bundle(bundle)


def test_freeze_rejects_duplicate_tool() -> None:
    bundle = ExtensionBundle(
        tools=[
            ExtensionTool(
                name="lookup_threat_intel",
                description="x",
                input_schema={"type": "object"},
                handler_kind="static_text",
                handler_config="a",
            ),
            ExtensionTool(
                name="lookup_threat_intel",
                description="y",
                input_schema={"type": "object"},
                handler_kind="static_text",
                handler_config="b",
            ),
        ]
    )
    with pytest.raises(RegistrationError, match="duplicate"):
        freeze_bundle(bundle)


def test_dispatcher_static_and_template() -> None:
    bundle = ExtensionBundle(
        tools=[
            ExtensionTool(
                name="static_one",
                description="d",
                input_schema={"type": "object"},
                handler_kind="static_text",
                handler_config="HELLO",
            ),
            ExtensionTool(
                name="template_one",
                description="d",
                input_schema={
                    "type": "object",
                    "properties": {"ioc": {"type": "string"}},
                    "required": ["ioc"],
                },
                handler_kind="templated_text",
                handler_config="ioc={{ args.ioc }} size={{ session.roster_size }}",
            ),
        ]
    )
    registry = freeze_bundle(bundle)
    audit = AuditLog(ring_size=10)
    disp = ExtensionDispatcher(registry=registry, audit=audit, max_template_bytes=1024)

    out = disp.invoke(
        name="static_one",
        args={},
        session_ctx={"roster_size": "small"},
        session_id="s",
        turn_id=None,
    )
    assert out == "HELLO"
    out = disp.invoke(
        name="template_one",
        args={"ioc": "1.2.3.4"},
        session_ctx={"roster_size": "small"},
        session_id="s",
        turn_id=None,
    )
    assert "1.2.3.4" in out
    assert "small" in out


def test_dispatcher_blocks_sandbox_escape() -> None:
    bundle = ExtensionBundle(
        tools=[
            ExtensionTool(
                name="evil",
                description="d",
                input_schema={"type": "object"},
                handler_kind="templated_text",
                handler_config="{{ ''.__class__.__mro__ }}",
            )
        ]
    )
    registry = freeze_bundle(bundle)
    audit = AuditLog(ring_size=10)
    disp = ExtensionDispatcher(registry=registry, audit=audit, max_template_bytes=4096)
    with pytest.raises(ExtensionDispatchError):
        disp.invoke(
            name="evil",
            args={},
            session_ctx={},
            session_id="s",
            turn_id=None,
        )


def test_dispatcher_validates_required_arg() -> None:
    bundle = ExtensionBundle(
        tools=[
            ExtensionTool(
                name="t",
                description="d",
                input_schema={
                    "type": "object",
                    "properties": {"q": {"type": "string"}},
                    "required": ["q"],
                },
                handler_kind="templated_text",
                handler_config="q={{ args.q }}",
            )
        ]
    )
    registry = freeze_bundle(bundle)
    audit = AuditLog(ring_size=10)
    disp = ExtensionDispatcher(registry=registry, audit=audit, max_template_bytes=4096)
    with pytest.raises(ExtensionDispatchError, match="required"):
        disp.invoke(
            name="t", args={}, session_ctx={}, session_id="s", turn_id=None
        )


def test_envloader_inline_and_path(monkeypatch, tmp_path: Path) -> None:
    file_path = tmp_path / "tools.json"
    file_path.write_text(
        json.dumps(
            [
                {
                    "name": "from_file",
                    "description": "d",
                    "input_schema": {"type": "object"},
                    "handler_kind": "static_text",
                    "handler_config": "FILE",
                }
            ]
        )
    )
    settings = _settings_with(
        monkeypatch,
        EXTENSIONS_TOOLS_JSON=json.dumps(
            [
                {
                    "name": "inline",
                    "description": "d",
                    "input_schema": {"type": "object"},
                    "handler_kind": "static_text",
                    "handler_config": "INLINE",
                }
            ]
        ),
        EXTENSIONS_TOOLS_PATH=str(file_path),
    )
    bundle = asyncio.run(EnvLoader(settings).load())
    # Inline wins
    assert [t.name for t in bundle.tools] == ["inline"]


def test_envloader_invalid_json(monkeypatch) -> None:
    settings = _settings_with(monkeypatch, EXTENSIONS_TOOLS_JSON="{not json}")
    with pytest.raises(RegistrationError):
        asyncio.run(EnvLoader(settings).load())


def test_resource_lookup() -> None:
    bundle = ExtensionBundle(
        resources=[
            ExtensionResource(name="rb", description="d", content="step 1: triage")
        ]
    )
    registry = freeze_bundle(bundle)
    audit = AuditLog(ring_size=10)
    disp = ExtensionDispatcher(registry=registry, audit=audit)
    assert disp.lookup_resource("rb") == "step 1: triage"
    with pytest.raises(ExtensionDispatchError):
        disp.lookup_resource("missing")


def test_prompt_scope_validation() -> None:
    bundle = ExtensionBundle(
        prompts=[ExtensionPrompt(name="p", description="d", body="b", scope="system")]
    )
    registry = freeze_bundle(bundle)
    assert registry.prompts["p"].scope == "system"
