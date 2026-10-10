from __future__ import annotations

import random
from datetime import datetime, timedelta, timezone

from .schedule import current_mood, get_timezone, in_time_ranges, parse_time_ranges


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
