from __future__ import annotations

from datetime import datetime, timezone, tzinfo
from zoneinfo import ZoneInfo


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
