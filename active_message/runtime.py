from __future__ import annotations

import asyncio
import math
import time
from datetime import datetime
from typing import Any

from .config import PluginConfig
from .models import MessageObservation, SessionRuntimeState


class RuntimeStore:
    """有界短期统计与可恢复调度数据；持久化中不含消息原文。"""

    MAX_SESSIONS = 500

    def __init__(self) -> None:
        self.sessions: dict[str, SessionRuntimeState] = {}
        self.unreplied: dict[str, int] = {}
        self.seen_incoming: dict[str, list[str]] = {}
        self.seen_sends: dict[str, list[str]] = {}

    def get(self, sid: str) -> SessionRuntimeState:
        if sid not in self.sessions and len(self.sessions) >= self.MAX_SESSIONS:
            raise ValueError("session capacity reached (500); configure a smaller whitelist")
        return self.sessions.setdefault(sid, SessionRuntimeState())

    def prune(self, state: SessionRuntimeState, config: PluginConfig, now: float) -> None:
        state.recent_human[:] = [
            message for message in state.recent_human
            if now - message.timestamp <= config.activity_window_seconds
        ][-config.max_recent_messages:]
        state.recent_bot_timestamps[:] = [
            timestamp for timestamp in state.recent_bot_timestamps
            if now - timestamp <= config.energy_window_seconds
        ][-config.max_recent_messages:]

    def incoming(self, sid: str, observation: MessageObservation, config: PluginConfig,
                 *, context_limit: int = 1000) -> bool:
        seen = self.seen_incoming.setdefault(sid, [])
        if observation.message_id and observation.message_id in seen:
            return False
        seen.append(observation.message_id)
        del seen[:-config.max_recent_messages]
        state = self.get(sid)
        state.last_human_at = observation.timestamp
        state.recent_human.append(observation)
        state.recent_context.append(observation)
        del state.recent_context[:-max(1, context_limit)]
        self.unreplied[sid] = 0
        self.prune(state, config, observation.timestamp)
        return True

    def sent(self, sid: str, key: str, date: str, config: PluginConfig, *, proactive: bool) -> bool:
        seen = self.seen_sends.setdefault(sid, [])
        if key in seen:
            return False
        seen.append(key)
        del seen[:-config.max_recent_messages]
        state = self.get(sid)
        now = time.time()
        state.last_bot_at = now
        state.recent_bot_timestamps.append(now)
        if proactive:
            self.consume_proactive(sid, date)
            self.unreplied[sid] = self.unreplied.get(sid, 0) + 1
        self.prune(state, config, now)
        return True

    def consume_proactive(self, sid: str, date: str) -> None:
        """消耗每日主动尝试额度；沿用旧存储字段，保留已有计数。

        正常完成但没发送只调用这里，不改变发言冷却、精力或无人回复数。
        调用方负责保证一轮只计一次。
        """
        state = self.get(sid)
        if state.last_bot_date and date < state.last_bot_date:
            return
        if state.last_bot_date != date:
            state.last_bot_date = date
            state.daily_proactive_sent = 0
        state.daily_proactive_sent += 1

    def invalidate(self, sid: str, *, preserve_batch: bool = False) -> None:
        state = self.sessions.get(sid)
        if state is None:
            return
        state.generation += 1
        state.judging = False
        if not preserve_batch:
            state.batch_started_at = None
        if state.pending_task is not None and not state.pending_task.done():
            state.pending_task.cancel()
        state.pending_task = None

    def dump(self) -> dict[str, Any]:
        return {
            "version": 1,
            "sessions": {
                sid: {
                    "last_human_at": state.last_human_at,
                    "recent_human_timestamps": [item.timestamp for item in state.recent_human],
                    "last_bot_at": state.last_bot_at,
                    "recent_bot_timestamps": state.recent_bot_timestamps,
                    "last_bot_date": state.last_bot_date,
                    "daily_proactive_sent": state.daily_proactive_sent,
                    "proactive_next_run": state.proactive_next_run,
                    "proactive_run_id": state.proactive_run_id,
                    "proactive_schedule_date": state.proactive_schedule_date,
                    "proactive_schedule": state.proactive_schedule,
                    "proactive_schedule_key": state.proactive_schedule_key,
                    "unreplied_count": self.unreplied.get(sid, 0),
                }
                for sid, state in self.sessions.items()
            },
        }

    def restore(self, payload: Any, max_recent_messages: int = 200) -> None:
        if not isinstance(payload, dict) or payload.get("version") != 1:
            return
        sessions = payload.get("sessions", {})
        if not isinstance(sessions, dict):
            return
        for sid, values in list(sessions.items())[:self.MAX_SESSIONS]:
            if not isinstance(sid, str) or not isinstance(values, dict):
                continue
            try:
                from .sessions import split_sid
                split_sid(sid)
                state = self.get(sid)
                for key in ("last_human_at", "last_bot_at"):
                    value = values.get(key)
                    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
                        setattr(state, key, float(value))
                raw_human = values.get("recent_human_timestamps", [])
                if isinstance(raw_human, list):
                    state.recent_human = [MessageObservation(float(ts), "", "", "", "") for ts in raw_human[-max_recent_messages:]
                                          if isinstance(ts, (int, float)) and not isinstance(ts, bool) and math.isfinite(ts)]
                raw_ts = values.get("recent_bot_timestamps", [])
                if isinstance(raw_ts, list):
                    state.recent_bot_timestamps = [float(v) for v in raw_ts if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)][-max_recent_messages:]
                state.last_bot_date = str(values.get("last_bot_date", ""))
                state.daily_proactive_sent = max(0, int(values.get("daily_proactive_sent", 0)))
                for key in ("proactive_next_run", "proactive_run_id", "proactive_schedule_date", "proactive_schedule_key"):
                    value = values.get(key)
                    setattr(state, key, value if isinstance(value, str) else "" if key in {"proactive_schedule_date", "proactive_schedule_key"} else None)
                state.proactive_schedule.clear()
                raw_schedule = values.get("proactive_schedule", [])
                if isinstance(raw_schedule, list):
                    for row in raw_schedule[:1000]:
                        if not isinstance(row, dict) or row.get("status") not in {"pending", "running", "sent", "quiet", "failed", "skipped", "missed"}:
                            continue
                        try:
                            point = datetime.fromisoformat(row.get("at", ""))
                        except (TypeError, ValueError):
                            continue
                        if point.tzinfo is None:
                            continue
                        restored = {"at": point.isoformat(), "status": row["status"]}
                        if isinstance(row.get("reason"), str):
                            restored["reason"] = row["reason"][:500]
                        if restored["status"] == "running":
                            restored["status"] = "missed"
                        elif restored["status"] == "pending" and point.timestamp() <= time.time():
                            restored["status"] = "missed"
                        state.proactive_schedule.append(restored)
                self.unreplied[sid] = max(0, int(values.get("unreplied_count", 0)))
            except (ValueError, TypeError, OverflowError):
                continue

    async def cancel_pending(self) -> None:
        tasks = []
        for sid in list(self.sessions):
            state = self.sessions[sid]
            if state.pending_task is not None:
                tasks.append(state.pending_task)
            self.invalidate(sid)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
