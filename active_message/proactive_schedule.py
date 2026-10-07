from __future__ import annotations

import random
from datetime import datetime, timedelta

from .schedule import current_mood, parse_time_ranges


def next_sleep_end(now: datetime, sleep_hours: str) -> datetime:
    ranges = parse_time_ranges(sleep_hours)
    candidates: list[datetime] = []
    for start, end in ranges:
        if start == end:
            candidates.append(now + timedelta(days=1))
            continue
        end_day = now.date()
        if start < end:
            if now.hour * 60 + now.minute >= end:
                end_day += timedelta(days=1)
        else:
            minute = now.hour * 60 + now.minute
            if minute >= start:
                end_day += timedelta(days=1)
        candidate = datetime.combine(end_day, datetime.min.time(), tzinfo=now.tzinfo).replace(
            hour=end // 60, minute=end % 60
        )
        if candidate <= now:
            candidate += timedelta(days=1)
        candidates.append(candidate)
    return min(candidates) if candidates else now + timedelta(hours=1)


def choose_proactive_run_at(
    *,
    now: datetime,
    timezone_name: str,
    sleep_hours: str,
    active_hours: str,
    min_minutes: int,
    max_minutes: int,
    active_multiplier: float,
) -> tuple[datetime, str]:
    """返回下一次主动聊天时间和三档心情。"""

    mood = current_mood(now, sleep_hours, active_hours)
    if mood == "睡眠":
        return next_sleep_end(now, sleep_hours), mood
    low = max(1, min(int(min_minutes), int(max_minutes)))
    high = max(low, int(max_minutes))
    delay = random.uniform(low, high)
    if mood == "活跃":
        delay *= max(0.1, float(active_multiplier))
    run_at_local = now + timedelta(minutes=delay)
    return run_at_local, mood
