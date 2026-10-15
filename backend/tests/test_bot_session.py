import asyncio
import ssl
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from aiogram import Bot
from aiogram.client.telegram import TelegramAPIServer
from aiogram.exceptions import ClientDecodeError, TelegramNetworkError
from aiohttp import ClientTimeout, TCPConnector, web
from aiohttp.test_utils import TestServer

from app.bot.runtime import create_dispatcher
from app.bot.session import TelegramConnector, TelegramSession


async def test_polling_uses_retrying_session_with_numeric_timeout(app_context, settings):
    app, _, factory, _ = app_context
    bot, _ = create_dispatcher(
        settings=settings,
        session_factory=factory,
        room_repository=app.state.room_repository,
        join_tokens=app.state.join_tokens,
        voice_service=app.state.voice_service,
    )
    try:
        assert isinstance(bot.session, TelegramSession)
        assert int(bot.session.timeout + 30) == 90
        session = await bot.session.create_session()
        assert isinstance(session.connector, TelegramConnector)
        assert await bot.session.create_session() is session
    finally:
        await bot.session.close()
    assert session.closed


async def test_connect_retries_only_before_returning_a_connection(monkeypatch, caplog):
    connection = object()
    connect = AsyncMock(side_effect=[TimeoutError("secret-token-url"), connection])
    monkeypatch.setattr(TCPConnector, "connect", connect)
    request = SimpleNamespace(url="https://api.telegram.org/botsecret-token/sendMessage")
    timeout = ClientTimeout(total=60)
    async with TelegramConnector() as connector:
        assert await connector.connect(request, [], timeout) is connection
    assert connect.await_count == 2
    assert all(call.args == (request, [], timeout) for call in connect.await_args_list)
    assert "secret-token" not in caplog.text


async def test_connect_stops_after_eight_attempts(monkeypatch):
    connect = AsyncMock(side_effect=TimeoutError())
    monkeypatch.setattr(TCPConnector, "connect", connect)
    async with TelegramConnector() as connector:
        with pytest.raises(TimeoutError):
            await connector.connect(SimpleNamespace(), [], ClientTimeout(total=60))
    assert connect.await_count == 8


async def test_each_connection_attempt_has_a_five_second_deadline(monkeypatch):
    deadlines = []
    real_timeout = asyncio.timeout

    def record_timeout(delay):
        deadlines.append(delay)
        return real_timeout(delay)

    monkeypatch.setattr(asyncio, "timeout", record_timeout)
    connect = AsyncMock(side_effect=[TimeoutError(), object()])
    monkeypatch.setattr(TCPConnector, "connect", connect)
    async with TelegramConnector() as connector:
        await connector.connect(SimpleNamespace(), [], ClientTimeout(total=60))
    assert deadlines == [5, 5]


@pytest.mark.parametrize(
    "error",
    [
        ssl.SSLCertVerificationError("invalid certificate"),
        OSError("unreachable"),
        asyncio.CancelledError(),
    ],
)
async def test_non_timeout_errors_and_cancellation_are_not_retried(monkeypatch, error):
    connect = AsyncMock(side_effect=error)
    monkeypatch.setattr(TCPConnector, "connect", connect)
    async with TelegramConnector() as connector:
        with pytest.raises(type(error)):
            await connector.connect(SimpleNamespace(), [], ClientTimeout(total=60))
    assert connect.await_count == 1


async def test_outer_request_deadline_is_not_retried(monkeypatch):
    started = asyncio.Event()

    async def blocked_connect(*args):
        started.set()
        await asyncio.Event().wait()

    connect = AsyncMock(side_effect=blocked_connect)
    monkeypatch.setattr(TCPConnector, "connect", connect)
    async with TelegramConnector() as connector:
        with pytest.raises(TimeoutError):
            async with asyncio.timeout(0.02):
                await connector.connect(SimpleNamespace(), [], ClientTimeout(total=0.02))
    assert started.is_set()
    assert connect.await_count == 1


async def test_a_connect_retry_sends_exactly_one_http_post(monkeypatch):
    posts = []

    async def send_message(request):
        posts.append(dict(await request.post()))
        return web.json_response(
            {
                "ok": True,
                "result": {
                    "message_id": 7,
                    "date": 0,
                    "chat": {"id": -100, "type": "supergroup"},
                    "text": "hello",
                },
            }
        )

    app = web.Application()
    app.router.add_post("/bot{token}/sendMessage", send_message)
    create_connection = TCPConnector._create_connection
    attempts = 0

    async def fail_first_connection(self, request, traces, request_timeout):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise TimeoutError()
        return await create_connection(self, request, traces, request_timeout)

    monkeypatch.setattr(TCPConnector, "_create_connection", fail_first_connection)
    async with TestServer(app) as server:
        session = TelegramSession()
        session.api = TelegramAPIServer.from_base(str(server.make_url("/")))
        async with Bot("123456:TEST_TOKEN", session=session) as bot:
            message = await bot.send_message(-100, "hello")
    assert message.message_id == 7
    assert attempts == 2
    assert len(posts) == 1
    assert posts[0]["text"] == "hello"


@pytest.mark.parametrize(
    "failure, expected_error",
    [
        ("response_timeout", TelegramNetworkError),
        ("disconnect", TelegramNetworkError),
        ("invalid_json", ClientDecodeError),
    ],
)
async def test_an_accepted_post_is_never_replayed(failure, expected_error):
    posts = []
    release = asyncio.Event()

    async def send_message(request):
        posts.append(dict(await request.post()))
        if failure == "response_timeout":
            await release.wait()
        elif failure == "disconnect":
            request.transport.close()
        else:
            return web.Response(text="not JSON")
        return web.json_response({"ok": True, "result": True})

    app = web.Application()
    app.router.add_post("/bot{token}/sendMessage", send_message)
    async with TestServer(app) as server:
        session = TelegramSession()
        session.api = TelegramAPIServer.from_base(str(server.make_url("/")))
        try:
            async with Bot("123456:TEST_TOKEN", session=session) as bot:
                with pytest.raises(expected_error):
                    await bot.send_message(-100, "hello", request_timeout=0.05)
        finally:
            release.set()
    assert len(posts) == 1


async def test_long_poll_timeout_override_is_preserved(monkeypatch):
    session = TelegramSession()
    client = await session.create_session()
    post = Mock()
    post.side_effect = AssertionError("request captured")
    monkeypatch.setattr(client, "post", post)
    try:
        async with Bot("123456:TEST_TOKEN", session=session) as bot:
            with pytest.raises(AssertionError, match="request captured"):
                await bot.get_updates(timeout=30, request_timeout=90)
    finally:
        await session.close()
    assert post.call_args.kwargs["timeout"] == 90


async def test_exhausted_connect_attempts_keep_the_sdk_network_error(monkeypatch):
    connect = AsyncMock(side_effect=TimeoutError())
    monkeypatch.setattr(TCPConnector, "connect", connect)
    async with Bot("123456:TEST_TOKEN", session=TelegramSession()) as bot:
        with pytest.raises(TelegramNetworkError):
            await bot.get_me()
    assert connect.await_count == 8
