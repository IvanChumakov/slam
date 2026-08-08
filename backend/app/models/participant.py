from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base


class RoomParticipant(Base):
    __tablename__ = "room_participants"
    __table_args__ = (
        UniqueConstraint("room_id", "identity", name="uq_room_participants_room_identity"),
    )

    id: Mapped[int] = mapped_column(
        BigInteger().with_variant(Integer, "sqlite"), primary_key=True, autoincrement=True
    )
    room_id: Mapped[int] = mapped_column(
        ForeignKey("voice_rooms.id", ondelete="CASCADE"), nullable=False, index=True
    )
    identity: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    joined_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    room: Mapped["VoiceRoom"] = relationship(back_populates="participants")  # noqa: F821
