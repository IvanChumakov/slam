from sqlalchemy import BigInteger, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class TelegramTopic(Base):
    __tablename__ = "telegram_topics"

    telegram_chat_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    telegram_thread_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
