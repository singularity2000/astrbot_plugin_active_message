"""所有主动会话共用一个可重设闹钟，不每分钟轮询。"""
from __future__ import annotations
import asyncio
from collections.abc import Awaitable, Callable


class DeadlineAlarm:
    def __init__(self, tick: Callable[[], Awaitable[None]], next_delay: Callable[[], float | None], on_error):
        self.tick = tick
        self.next_delay = next_delay
        self.on_error = on_error
        self.changed = asyncio.Event()
        self.task: asyncio.Task | None = None

    def start(self):
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._run(), name="active-message-alarm")

    def wake(self):
        self.changed.set()

    async def close(self):
        if self.task is not None:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            self.task = None

    async def _run(self):
        while True:
            self.changed.clear()
            try:
                await self.tick()
                delay = self.next_delay()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.on_error(exc)
                # Exceptional retry only; healthy operation never polls periodically.
                delay = 60.0
            try:
                if delay is None:
                    await self.changed.wait()
                else:
                    await asyncio.wait_for(self.changed.wait(), timeout=max(0.001, delay))
            except TimeoutError:
                pass
