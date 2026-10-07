from __future__ import annotations

import re
from collections import defaultdict
from typing import Iterable

from .config import PluginConfig, SessionGroup

VALID_MESSAGE_TYPES = {"GroupMessage", "FriendMessage"}


def split_sid(sid: str) -> tuple[str, str, str]:
    """SID 的第一段是适配器实例 ID，不是适配器类型。"""

    parts = sid.split(":", 2)
    if len(parts) != 3 or not parts[0] or parts[1] not in VALID_MESSAGE_TYPES or not parts[2]:
        raise ValueError("SID must be platform_id:GroupMessage/FriendMessage:session_id")
    return parts[0], parts[1], parts[2]


class SessionScopes:
    """范围匹配与裸 ID 的事件内消歧，绝不猜第一个平台。"""

    def __init__(self, config: PluginConfig) -> None:
        self.config = config
        self._resolved: dict[str, str] = {}
        self._bare_seen: dict[str, set[str]] = defaultdict(set)
        self._owners: dict[str, SessionGroup] = {}
        for group in config.groups:
            for sid in group.sids:
                if sid in self._owners:
                    raise ValueError(f"SID {sid} appears in multiple groups")
                if ":" in sid:
                    split_sid(sid)
                elif not re.fullmatch(r"-?\d+", sid):
                    raise ValueError("bare session IDs must be numeric; use full SID otherwise")
                self._owners[sid] = group

    def observe(self, sid: str, raw_session_id: str, group_id: str = "") -> None:
        for bare in {raw_session_id, group_id} - {""}:
            if bare in self._owners:
                self._bare_seen[bare].add(sid)
                if len(self._bare_seen[bare]) == 1:
                    if sid in self._owners and self._owners[sid] is not self._owners[bare]:
                        self._resolved.pop(bare, None)
                        continue
                    self._resolved[bare] = sid
                else:
                    self._resolved.pop(bare, None)

    def match(self, sid: str) -> tuple[bool, SessionGroup | None]:
        if not self.config.groups:
            return True, None
        if sid in self._owners:
            return True, self._owners[sid]
        for bare, resolved in self._resolved.items():
            if resolved == sid:
                return True, self._owners[bare]
        return False, None

    def targets(self, observed_sids: Iterable[str]) -> list[str]:
        if not self.config.groups:
            return sorted(set(observed_sids))
        targets = [sid for sid in self._owners if ":" in sid]
        targets.extend(self._resolved.values())
        return sorted(set(targets))

    def unresolved(self) -> list[str]:
        return [sid for sid in self._owners if ":" not in sid and sid not in self._resolved]

    def inherit_observations(self, previous: "SessionScopes") -> None:
        """Re-resolve known aliases after settings edits; never guess a platform."""
        for bare, sids in previous._bare_seen.items():
            for sid in sids:
                self.observe(sid, bare)
