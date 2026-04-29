"""Pydantic models for the extensions registry."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ExtensionTool(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    description: str
    input_schema: dict[str, Any]
    handler_kind: Literal["static_text", "templated_text"]
    handler_config: str

    @field_validator("name")
    @classmethod
    def _name_shape(cls, v: str) -> str:
        if not v or not v.replace("_", "").isalnum():
            raise ValueError("tool name must be alphanumeric (underscores allowed)")
        if len(v) > 64:
            raise ValueError("tool name too long")
        return v


class ExtensionResource(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    description: str
    content: str


class ExtensionPrompt(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    description: str
    body: str
    scope: Literal["system", "snippet"] = "snippet"


class ExtensionBundle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tools: list[ExtensionTool] = Field(default_factory=list)
    resources: list[ExtensionResource] = Field(default_factory=list)
    prompts: list[ExtensionPrompt] = Field(default_factory=list)
