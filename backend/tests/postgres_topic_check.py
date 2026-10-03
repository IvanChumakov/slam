"""Run on a disposable PostgreSQL database, never on the production database."""

import asyncio
import os

import asyncpg
from alembic.config import Config
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from alembic import command
from app.db.repositories import RoomRepository
from app.models import VoiceRoom

config = Config("alembic.ini")
url = os.environ["DATABASE_URL"]
if "@slam-topic-check-db:" not in url:
    raise RuntimeError("This check requires the disposable slam-topic-check-db database")


async def seed_legacy() -> None:
    connection = await asyncpg.connect(url.replace("postgresql+asyncpg://", "postgresql://"))
    try:
        await connection.execute("""
            INSERT INTO telegram_groups (telegram_chat_id, title) VALUES (-123, 'Legacy');
            INSERT INTO voice_rooms (group_id, name, livekit_room_name, telegram_message_id)
            SELECT id, 'General', 'telegram_123_general', 777 FROM telegram_groups;
        """)
    finally:
        await connection.close()


async def check_rooms() -> None:
    engine = create_async_engine(url)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    repository = RoomRepository()
    try:
        async with factory() as session:
            legacy = await repository.ensure_general_room(
                session, telegram_chat_id=-123, title="Legacy"
            )
            assert legacy.id == 1
            assert legacy.telegram_thread_id == 0
            assert legacy.telegram_message_id == 777
            assert legacy.livekit_room_name == "telegram_123_general"
            await session.commit()

        async def ensure(thread_id: int) -> int:
            async with factory() as session:
                room = await repository.ensure_general_room(
                    session, telegram_chat_id=-123, title="Legacy", telegram_thread_id=thread_id
                )
                await session.commit()
                return room.id

        ids = await asyncio.gather(*(ensure(42) for _ in range(8)))
        assert len(set(ids)) == 1
        other_id = await ensure(43)
        assert other_id not in (1, ids[0])
        async with factory() as session:
            assert await session.scalar(select(func.count(VoiceRoom.id))) == 3
            await repository.remember_topic_name(
                session, telegram_chat_id=-123, telegram_thread_id=42, name="Игры"
            )
            await session.commit()
        async with factory() as session:
            room = await repository.ensure_general_room(
                session, telegram_chat_id=-123, title="Legacy", telegram_thread_id=42
            )
            assert room.id == ids[0]
            assert room.name == "Игры"
            await repository.remember_topic_name(
                session, telegram_chat_id=-123, telegram_thread_id=42, name="Работа"
            )
            await session.commit()
        async with factory() as session:
            room = await session.get(VoiceRoom, ids[0])
            assert room.name == "Работа"
        print("PostgreSQL: legacy room preserved; concurrent /voice reuses one topic room")
    finally:
        await engine.dispose()


if __name__ == "__main__":
    command.upgrade(config, "0001_initial")
    asyncio.run(seed_legacy())
    command.upgrade(config, "head")
    command.downgrade(config, "0001_initial")
    command.upgrade(config, "head")
    asyncio.run(check_rooms())
