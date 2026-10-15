"""Track card pins, old card cleanup, and uncertain replacement delivery."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0004_room_card_pins"
down_revision: str | None = "0003_topic_names"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "voice_rooms",
        sa.Column("telegram_pending_unpin_ids", sa.JSON(), nullable=False, server_default="[]"),
    )
    op.add_column(
        "voice_rooms",
        sa.Column("telegram_pin_pending", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "voice_rooms",
        sa.Column(
            "telegram_replacement_blocked", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
    )


def downgrade() -> None:
    op.drop_column("voice_rooms", "telegram_replacement_blocked")
    op.drop_column("voice_rooms", "telegram_pin_pending")
    op.drop_column("voice_rooms", "telegram_pending_unpin_ids")
