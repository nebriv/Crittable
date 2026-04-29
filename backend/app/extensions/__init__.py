"""Skills-style extensions: tools, resources, prompts."""

from .loaders.env import EnvLoader
from .models import (
    ExtensionBundle,
    ExtensionPrompt,
    ExtensionResource,
    ExtensionTool,
)
from .registry import (
    BUILTIN_TOOL_NAMES,
    FrozenRegistry,
    RegistrationError,
    freeze_bundle,
)

__all__ = [
    "BUILTIN_TOOL_NAMES",
    "EnvLoader",
    "ExtensionBundle",
    "ExtensionPrompt",
    "ExtensionResource",
    "ExtensionTool",
    "FrozenRegistry",
    "RegistrationError",
    "freeze_bundle",
]
