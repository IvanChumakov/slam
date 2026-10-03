from aiogram import Bot
from aiogram.types import BotCommand, BotCommandScopeAllGroupChats, BotCommandScopeDefault


async def register_commands(bot: Bot) -> None:
    voice = BotCommand(command="voice", description="🎧 Открыть голосовую комнату топика")
    await bot.set_my_commands(
        commands=[voice, BotCommand(command="start", description="Как подключить бота")],
        scope=BotCommandScopeDefault(),
    )
    await bot.set_my_commands(commands=[voice], scope=BotCommandScopeAllGroupChats())
