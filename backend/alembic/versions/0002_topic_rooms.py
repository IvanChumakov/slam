"""Scope voice rooms to Telegram topics, preserving existing General rooms."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0002_topic_rooms"
down_revision: str | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "voice_rooms",
        sa.Column("telegram_thread_id", sa.BigInteger(), server_default="0", nullable=False),
    )
    op.drop_constraint("uq_voice_rooms_group_id", "voice_rooms", type_="unique")
    op.create_unique_constraint(
        "uq_voice_rooms_group_thread", "voice_rooms", ["group_id", "telegram_thread_id"]
    )


def downgrade() -> None:
    # Recreating the old unique constraint fails safely if a group has multiple rooms.
    # Never delete topic rooms to make a downgrade succeed.
    op.create_unique_constraint("uq_voice_rooms_group_id", "voice_rooms", ["group_id"])
    op.drop_constraint("uq_voice_rooms_group_thread", "voice_rooms", type_="unique")
    op.drop_column("voice_rooms", "telegram_thread_id")
