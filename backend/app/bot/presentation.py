from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup


def room_message(name: str, online_count: int, participant_names: tuple[str, ...] = ()) -> str:
    lines = [f"🔊 {name}", "", f"Сейчас в комнате: {online_count}"]
    if participant_names:
        lines.extend(("", *participant_names))
    return "\n".join(lines)


def join_keyboard(join_url: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[[InlineKeyboardButton(text="🎧 Join Voice", url=join_url)]]
    )
