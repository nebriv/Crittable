from __future__ import annotations

import pytest

from app.sessions.models import Session
from app.sessions.repository import (
    InMemoryRepository,
    SessionCapacityError,
    SessionNotFoundError,
)


@pytest.mark.asyncio
async def test_crud_round_trip() -> None:
    repo = InMemoryRepository(max_sessions=3)
    s = Session(scenario_prompt="incident")
    await repo.create(s)
    fetched = await repo.get(s.id)
    assert fetched.id == s.id
    listed = await repo.list()
    assert len(listed) == 1
    await repo.delete(s.id)
    with pytest.raises(SessionNotFoundError):
        await repo.get(s.id)


@pytest.mark.asyncio
async def test_capacity_overflow() -> None:
    repo = InMemoryRepository(max_sessions=2)
    await repo.create(Session(scenario_prompt="a"))
    await repo.create(Session(scenario_prompt="b"))
    with pytest.raises(SessionCapacityError):
        await repo.create(Session(scenario_prompt="c"))


@pytest.mark.asyncio
async def test_double_create_rejected() -> None:
    repo = InMemoryRepository(max_sessions=5)
    s = Session(scenario_prompt="a")
    await repo.create(s)
    with pytest.raises(ValueError):
        await repo.create(s)
