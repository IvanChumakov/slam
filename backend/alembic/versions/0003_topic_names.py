"""Remember Telegram topic names without creating voice rooms."""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0003_topic_names"
down_revision: str | None = "0002_topic_rooms"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "telegram_topics",
        sa.Column("telegram_chat_id", sa.BigInteger(), nullable=False),
        sa.Column("telegram_thread_id", sa.BigInteger(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint(
            "telegram_chat_id", "telegram_thread_id", name="pk_telegram_topics"
        ),
    )


def downgrade() -> None:
    op.drop_table("telegram_topics")
