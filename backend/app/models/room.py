from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class VoiceRoom(Base):
    __tablename__ = "voice_rooms"
    __table_args__ = (UniqueConstraint("group_id", name="uq_voice_rooms_group_id"),)

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    group_id: Mapped[int] = mapped_column(
        ForeignKey("telegram_groups.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(Text, nullable=False, default="General")
    livekit_room_name: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    telegram_message_id: Mapped[int | None] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    group: Mapped["TelegramGroup"] = relationship(back_populates="room")  # noqa: F821
    participants: Mapped[list["RoomParticipant"]] = relationship(  # noqa: F821
        back_populates="room", cascade="all, delete-orphan"
    )
