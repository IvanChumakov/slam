import asyncio

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.config import Settings, get_settings
from app.db.repositories import RoomRepository
from app.db.session import create_db_engine, create_session_factory
from app.services.tokens import JoinTokenService

LOCAL_TELEGRAM_CHAT_ID = -1_000_000_000_001


async def create_local_invite(
    settings: Settings,
    session_factory: async_sessionmaker[AsyncSession],
) -> str:
    if settings.environment == "production":
        raise RuntimeError("local invites are disabled in production")

    repository = RoomRepository()
    async with session_factory() as session:
        room = await repository.ensure_general_room(
            session,
            telegram_chat_id=LOCAL_TELEGRAM_CHAT_ID,
            title="Local Test",
        )
        await session.commit()

    tokens = JoinTokenService(
        settings.join_token_secret.get_secret_value(),
        settings.join_token_ttl_seconds,
    )
    token = tokens.create_join_token(room.id, LOCAL_TELEGRAM_CHAT_ID)
    return f"{str(settings.frontend_public_url).rstrip('/')}/join/{token}"


async def run() -> None:
    settings = get_settings()
    engine = create_db_engine(settings.database_url)
    factory = create_session_factory(engine)
    try:
        invite = await create_local_invite(settings, factory)
        print("\nOpen this URL in two browser windows:\n")
        print(invite)
    finally:
        await engine.dispose()


if __name__ == "__main__":
    asyncio.run(run())
