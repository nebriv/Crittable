"""EnvLoader — Phase 2 ships JSON-from-env-var-or-file loaders only."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from ...config import Settings
from ...logging_setup import get_logger
from ..models import (
    ExtensionBundle,
    ExtensionPrompt,
    ExtensionResource,
    ExtensionTool,
)
from ..registry import RegistrationError

_logger = get_logger("extensions.env_loader")


class EnvLoader:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def load(self) -> ExtensionBundle:
        tools = _parse(
            inline=self._settings.extensions_tools_json,
            path=self._settings.extensions_tools_path,
            kind="tools",
            model=ExtensionTool,
        )
        resources = _parse(
            inline=self._settings.extensions_resources_json,
            path=self._settings.extensions_resources_path,
            kind="resources",
            model=ExtensionResource,
        )
        prompts = _parse(
            inline=self._settings.extensions_prompts_json,
            path=self._settings.extensions_prompts_path,
            kind="prompts",
            model=ExtensionPrompt,
        )
        bundle = ExtensionBundle(tools=tools, resources=resources, prompts=prompts)
        _logger.info(
            "extensions_loaded",
            tools=len(bundle.tools),
            resources=len(bundle.resources),
            prompts=len(bundle.prompts),
        )
        return bundle


def _parse(
    *,
    inline: str | None,
    path: str | None,
    kind: str,
    model: type[Any],
) -> list[Any]:
    raw = _read_json(inline=inline, path=path, kind=kind)
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise RegistrationError(f"EXTENSIONS_{kind.upper()} must decode to a list")
    out = []
    for index, entry in enumerate(raw):
        try:
            out.append(model.model_validate(entry))
        except ValidationError as exc:
            raise RegistrationError(
                f"invalid {kind} entry at index {index}: {exc}"
            ) from exc
    return out


def _read_json(*, inline: str | None, path: str | None, kind: str) -> Any:
    if inline:
        try:
            return json.loads(inline)
        except json.JSONDecodeError as exc:
            raise RegistrationError(
                f"EXTENSIONS_{kind.upper()}_JSON failed to parse: {exc}"
            ) from exc
    if path:
        p = Path(path)
        if not p.is_file():
            raise RegistrationError(
                f"EXTENSIONS_{kind.upper()}_PATH does not exist: {path}"
            )
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise RegistrationError(
                f"EXTENSIONS_{kind.upper()}_PATH failed to parse: {exc}"
            ) from exc
    return None
