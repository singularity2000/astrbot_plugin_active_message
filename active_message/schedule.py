"""作息时段、下次主动时间计算与可重设的单闹钟调度。"""
from __future__ import annotations

import random
import asyncio
from datetime import datetime, timezone, tzinfo, timedelta
from zoneinfo import ZoneInfo
from collections.abc import Awaitable, Callable


def get_timezone(name: str) -> tzinfo:
    if name:
        return ZoneInfo(name)
    return datetime.now().astimezone().tzinfo or timezone.utc


def parse_time_ranges(spec: str) -> list[tuple[int, int]]:
    """多个时间段以逗号分隔，支持跨午夜；相同起止表示全天。"""

    if not spec.strip():
        return []
    ranges: list[tuple[int, int]] = []
    for part in spec.split(","):
        pieces = part.strip().split("-")
        if len(pieces) != 2:
            raise ValueError("time ranges must look like 23:00-07:00")
        minutes: list[int] = []
        for clock in pieces:
            hours, mins = clock.strip().split(":")
            h, m = int(hours), int(mins)
            if h < 0 or h > 23 or m < 0 or m > 59:
                raise ValueError("invalid hour/minute")
            minutes.append(h * 60 + m)
        ranges.append((minutes[0], minutes[1]))
    return ranges


def in_time_ranges(now: datetime, ranges: list[tuple[int, int]]) -> bool:
    minute = now.hour * 60 + now.minute
    return any(
        start == end
        or (start <= minute < end if start < end else minute >= start or minute < end)
        for start, end in ranges
    )


def current_mood(now: datetime, sleep_hours: str, active_hours: str) -> str:
    if in_time_ranges(now, parse_time_ranges(sleep_hours)):
        return "睡眠"
    if in_time_ranges(now, parse_time_ranges(active_hours)):
        return "活跃"
    return "正常"


PROACTIVE_SCHEDULE_VERSION = 2


def _next_boundary(now: datetime, boundaries: list[int]) -> datetime:
    """返回下一个当地作息边界（UTC）；时区偏移变化也会切分等待区间。"""
    now_utc = now.astimezone(timezone.utc)
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    candidates = (
        (midnight + timedelta(days=day, minutes=minute))
        .replace(fold=fold).astimezone(timezone.utc)
        for day in (0, 1)
        for minute in boundaries
        for fold in (0, 1)
    )
    boundary = min(candidate for candidate in candidates if candidate > now_utc)
    # 夏令时可跳过或重复某个作息边界。先走到偏移切换处，再按真实当地时间
    # 重新判断 mood，避免在不存在的钟表时间或睡眠时段安排发言。
    offset = now.utcoffset()
    if boundary.astimezone(now.tzinfo).utcoffset() != offset:
        left, right = now_utc, boundary
        while right - left > timedelta(microseconds=1):
            middle = left + (right - left) // 2
            if middle.astimezone(now.tzinfo).utcoffset() == offset:
                left = middle
            else:
                right = middle
        boundary = right
    return boundary


def choose_proactive_run_at(
    *,
    now: datetime,
    timezone_name: str,
    sleep_hours: str,
    active_hours: str,
    min_minutes: int,
    max_minutes: int,
    active_multiplier: float,
) -> tuple[datetime | None, str]:
    """抽取一次等效正常等待量：睡眠暂停，活跃按倍率加速，跨段不重抽。

    返回计划时间和排期时的 mood；每天均无清醒时段时不安排计划。
    """
    tz = get_timezone(timezone_name) if timezone_name else now.tzinfo or get_timezone("")
    now = now.astimezone(tz) if now.tzinfo is not None else now.replace(tzinfo=tz)
    mood = current_mood(now, sleep_hours, active_hours)
    sleep_ranges = parse_time_ranges(sleep_hours)
    active_ranges = parse_time_ranges(active_hours)
    boundaries = sorted({0} | {
        minute for start, end in sleep_ranges + active_ranges for minute in (start, end)
    })
    # 在每个分段起点检查，兼容跨午夜、重叠时段及多段合起来覆盖全天。
    if all(in_time_ranges(now.replace(hour=minute // 60, minute=minute % 60), sleep_ranges)
           for minute in boundaries):
        return None, mood

    low = max(1, min(int(min_minutes), int(max_minutes)))
    high = max(low, int(max_minutes))
    remaining = random.uniform(low, high) * 60.0
    active_multiplier = max(0.1, float(active_multiplier))
    cursor = now
    while True:
        boundary = _next_boundary(cursor, boundaries)
        if not in_time_ranges(cursor, sleep_ranges):
            multiplier = active_multiplier if in_time_ranges(cursor, active_ranges) else 1.0
            cursor_utc = cursor.astimezone(timezone.utc)
            capacity = (boundary - cursor_utc).total_seconds() / multiplier
            if remaining < capacity:
                run_at = cursor_utc + timedelta(seconds=remaining * multiplier)
                # 微秒舍入也不能让结果越过边界，尤其不能落在睡眠起点。
                if run_at < boundary:
                    return run_at.astimezone(tz), mood
            remaining = max(0.0, remaining - capacity)
        # 睡眠段不扣除等待量；其余时段保留尚未消耗的部分。
        cursor = boundary.astimezone(tz)


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
