"""小型 JSON 运行数据存储：异步文件 I/O、原子替换、损坏保护。"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import Any


class StateFileError(Exception):
    """错误说明不包含运行数据正文。"""


class JsonStateFile:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._lock = asyncio.Lock()
        self._blocked = False

    @staticmethod
    def _validate(payload: Any) -> dict[str, Any]:
        if not isinstance(payload, dict) or payload.get("version") != 1 or not isinstance(payload.get("sessions"), dict):
            raise StateFileError("STATE_FORMAT_INVALID")
        return payload

    @staticmethod
    def _reject_nonfinite(_: str) -> None:
        raise ValueError("JSON contains a non-finite number")

    def _read(self) -> dict[str, Any]:
        try:
            with self.path.open("r", encoding="utf-8-sig") as stream:
                payload = json.load(stream, parse_constant=self._reject_nonfinite)
        except FileNotFoundError:
            return {}
        except (OSError, UnicodeError, ValueError):
            raise StateFileError("STATE_READ_FAILED") from None
        return self._validate(payload)

    async def load(self) -> dict[str, Any]:
        async with self._lock:
            try:
                payload = await asyncio.to_thread(self._read)
            except StateFileError:
                # Refuse subsequent saves rather than silently overwriting the
                # damaged or newer-format file with empty startup state.
                self._blocked = True
                raise
            self._blocked = False
            return payload

    def _write(self, serialized: str) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w", encoding="utf-8", newline="\n", dir=self.path.parent,
                prefix="." + self.path.name + ".", suffix=".tmp", delete=False,
            ) as stream:
                temporary = Path(stream.name)
                stream.write(serialized)
                stream.flush()
                os.fsync(stream.fileno())
            # The temporary file is closed before replacement (also on Windows).
            os.replace(temporary, self.path)
            temporary = None
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    async def save(self, payload: dict[str, Any]) -> None:
        self._validate(payload)
        try:
            # Capture a stable snapshot before a background thread reads it.
            serialized = json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        except (ValueError, TypeError):
            raise StateFileError("STATE_SERIALIZE_FAILED") from None
        async with self._lock:
            if self._blocked:
                raise StateFileError("STATE_FILE_PROTECTED")
            task = asyncio.create_task(asyncio.to_thread(self._write, serialized))
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                # Let the current atomic write finish before releasing the lock.
                await task
                raise
