"""Create Telegram groups, voice rooms, and participant presence.

Revision ID: 0001_initial
Revises:
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0001_initial"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "telegram_groups",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("telegram_chat_id", sa.BigInteger(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_telegram_groups"),
        sa.UniqueConstraint("telegram_chat_id", name="uq_telegram_groups_telegram_chat_id"),
    )
    op.create_table(
        "voice_rooms",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("group_id", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("livekit_room_name", sa.Text(), nullable=False),
        sa.Column("telegram_message_id", sa.BigInteger(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["group_id"],
            ["telegram_groups.id"],
            name="fk_voice_rooms_group_id_telegram_groups",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_voice_rooms"),
        sa.UniqueConstraint("group_id", name="uq_voice_rooms_group_id"),
        sa.UniqueConstraint("livekit_room_name", name="uq_voice_rooms_livekit_room_name"),
    )
    op.create_index("ix_voice_rooms_group_id", "voice_rooms", ["group_id"])
    op.create_table(
        "room_participants",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=True), nullable=False),
        sa.Column("room_id", sa.BigInteger(), nullable=False),
        sa.Column("identity", sa.Text(), nullable=False),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column(
            "joined_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["room_id"],
            ["voice_rooms.id"],
            name="fk_room_participants_room_id_voice_rooms",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_room_participants"),
        sa.UniqueConstraint("room_id", "identity", name="uq_room_participants_room_identity"),
    )
    op.create_index("ix_room_participants_room_id", "room_participants", ["room_id"])


def downgrade() -> None:
    op.drop_index("ix_room_participants_room_id", table_name="room_participants")
    op.drop_table("room_participants")
    op.drop_index("ix_voice_rooms_group_id", table_name="voice_rooms")
    op.drop_table("voice_rooms")
    op.drop_table("telegram_groups")
