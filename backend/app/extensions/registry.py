"""Frozen registries for extension tools, resources, and prompts."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType

from .models import ExtensionBundle, ExtensionPrompt, ExtensionResource, ExtensionTool

# Names reserved by the built-in tool surface — operators cannot shadow these.
BUILTIN_TOOL_NAMES = frozenset(
    {
        "address_role",
        "broadcast",
        "inject_event",
        "set_active_roles",
        "request_artifact",
        "use_extension_tool",
        "lookup_resource",
        "end_session",
        "inject_critical_event",
        "ask_setup_question",
        "propose_scenario_plan",
        "finalize_setup",
        "finalize_report",  # AAR-tier-only built-in
    }
)


class RegistrationError(ValueError):
    """Raised at startup when an extension definition is invalid."""


@dataclass(frozen=True)
class FrozenRegistry:
    tools: Mapping[str, ExtensionTool]
    resources: Mapping[str, ExtensionResource]
    prompts: Mapping[str, ExtensionPrompt]


def freeze_bundle(bundle: ExtensionBundle) -> FrozenRegistry:
    tools: dict[str, ExtensionTool] = {}
    for tool in bundle.tools:
        if tool.name in BUILTIN_TOOL_NAMES:
            raise RegistrationError(
                f"extension tool '{tool.name}' collides with a built-in name"
            )
        if tool.name in tools:
            raise RegistrationError(f"duplicate extension tool: {tool.name}")
        tools[tool.name] = tool

    resources: dict[str, ExtensionResource] = {}
    for resource in bundle.resources:
        if resource.name in resources:
            raise RegistrationError(
                f"duplicate extension resource: {resource.name}"
            )
        resources[resource.name] = resource

    prompts: dict[str, ExtensionPrompt] = {}
    for prompt in bundle.prompts:
        if prompt.name in prompts:
            raise RegistrationError(f"duplicate extension prompt: {prompt.name}")
        prompts[prompt.name] = prompt

    return FrozenRegistry(
        tools=MappingProxyType(tools),
        resources=MappingProxyType(resources),
        prompts=MappingProxyType(prompts),
    )
