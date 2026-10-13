"""作息时段、每日主动机会分配与可重设的单闹钟调度。"""
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


PROACTIVE_SCHEDULE_VERSION = 3


def _day_intervals(day: datetime, sleep_ranges: list[tuple[int, int]], active_ranges: list[tuple[int, int]]) -> list[tuple[datetime, datetime]]:
    """按真实经过的秒数展开当天活跃区间，兼容跨午夜和夏令时。"""
    boundaries = sorted({0} | {minute for pair in sleep_ranges + active_ranges for minute in pair})
    end = (day + timedelta(days=1)).astimezone(timezone.utc)
    cursor = day.astimezone(timezone.utc)
    intervals: list[tuple[datetime, datetime]] = []
    while cursor < end:
        local = cursor.astimezone(day.tzinfo)
        boundary = min(_next_boundary(local, boundaries), end)
        if in_time_ranges(local, active_ranges) and not in_time_ranges(local, sleep_ranges):
            if intervals and intervals[-1][1] == cursor:
                intervals[-1] = (intervals[-1][0], boundary)
            else:
                intervals.append((cursor, boundary))
        cursor = boundary
    return intervals


def choose_proactive_schedule(
    *, now: datetime, timezone_name: str, sleep_hours: str, active_hours: str,
    attempts: int, remaining_only: bool = False,
) -> list[datetime]:
    """按整天有效活跃时间分层随机抽样，只返回尚未过去的机会。

    每份在中间 60% 内独立随机取点，相邻份至少隔开一份时长的 40%；
    跨时段按有效秒数映射。中途启动不会把全天机会挤进剩余时间。
    remaining_only 仅供用户手动重排：将指定数量重新分布到当天剩余活跃区间。
    """
    tz = get_timezone(timezone_name) if timezone_name else now.tzinfo or get_timezone("")
    now = now.astimezone(tz) if now.tzinfo is not None else now.replace(tzinfo=tz)
    if attempts <= 0:
        return []
    sleep_ranges = parse_time_ranges(sleep_hours)
    active_ranges = parse_time_ranges(active_hours)
    day = now.replace(hour=0, minute=0, second=0, microsecond=0)
    intervals = _day_intervals(day, sleep_ranges, active_ranges)
    if remaining_only:
        cutoff = now.astimezone(timezone.utc)
        intervals = [(max(start, cutoff), end) for start, end in intervals if end > cutoff]
    total = sum((end - start).total_seconds() for start, end in intervals)
    count = int(attempts)
    if count <= 0 or total <= 0:
        return []
    points: list[datetime] = []
    for index in range(count):
        left = total * index / count
        right = total * (index + 1) / count
        width = right - left
        target = random.uniform(left + width * .2, left + width * .8)
        for start, end in intervals:
            length = (end - start).total_seconds()
            if target < length:
                point = start + timedelta(seconds=target)
                if point > now.astimezone(timezone.utc) and point < end:
                    points.append(point.astimezone(tz))
                break
            target -= length
    return points


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
