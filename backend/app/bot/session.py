import asyncio
import logging
from typing import override

from aiogram.client.session.aiohttp import AiohttpSession
from aiohttp import ClientTimeout, TCPConnector
from aiohttp.client_reqrep import ClientRequest
from aiohttp.connector import Connection
from aiohttp.tracing import Trace

logger = logging.getLogger(__name__)


class TelegramConnector(TCPConnector):
    @override
    async def connect(
        self, req: ClientRequest, traces: list[Trace], timeout: ClientTimeout
    ) -> Connection:
        attempt = 0
        while True:
            attempt += 1
            try:
                # Retry only acquisition: no HTTP headers or body have been sent here.
                async with asyncio.timeout(5):
                    return await super().connect(req, traces, timeout)
            except TimeoutError:
                logger.warning("Telegram connection timeout: attempt=%s max_attempts=8", attempt)
                if attempt == 8:
                    raise


class TelegramSession(AiohttpSession):
    def __init__(self) -> None:
        super().__init__()
        # aiogram has no public connector injection; retain its TLS, pooling and DNS settings.
        self._connector_type = TelegramConnector
