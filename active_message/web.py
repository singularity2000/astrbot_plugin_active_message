"""使用原生 Pages 的登录校验与接口，不另起服务器，不公开原始日志。"""
from __future__ import annotations
import asyncio
import copy
import hashlib
import json
import time
from .settings import Settings, shape_errors, schema
from .prompts import placeholder_catalog

KEEP_SECRET = "__ACTIVE_MESSAGE_KEEP_SECRET__"


def public_config(raw):
    result = copy.deepcopy(raw)
    decision = result.get("interjection", {}).get("decision", {})
    if decision.get("jev_api_key"):
        decision["jev_api_key"] = KEEP_SECRET
    return result


class PageAPI:
    def __init__(self, plugin):
        self.plugin = plugin
        self.handlers = []
        self._prefs_lock = asyncio.Lock()

    def register(self):
        for name in ("bootstrap", "status", "trace", "settings", "preview", "clear", "preferences"):
            handler = getattr(self, name)
            self.handlers.append(handler)
            self.plugin.context.register_web_api(f"/{self.plugin.PLUGIN_ID}/{name}", handler,
                ["POST"] if name in {"settings", "preview", "clear", "preferences"} else ["GET"], "主动会话运行检查台")

    def unregister(self):
        registry = self.plugin.context.registered_web_apis
        registry[:] = [api for api in registry if api[1] not in self.handlers]

    def revision(self):
        return hashlib.sha256(json.dumps(dict(self.plugin.config_raw), sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()

    def _auth(self):
        from astrbot.api.web import request
        if not request.username or request.plugin_name != self.plugin.PLUGIN_ID or self.plugin._closed:
            raise PermissionError("请登录 AstrBot Dashboard，且确保插件已加载。")
        return request

    def _response(self, data=None, error=None):
        from astrbot.api.web import json_response
        # Dashboard 的 Pages Bridge 会自动取出外层 data。
        # 外层遵循框架协议，内层保留插件结果及字段错误详情，避免被拆掉 ok。
        result = {"ok": error is None, "data": data, "error": error}
        return json_response({"status": "ok", "data": result},
                             headers={"Cache-Control": "no-store"})

    async def _body(self):
        request = self._auth()
        body = await request.body()
        if len(body) > 1024 * 1024:
            raise ValueError("配置请求超过 1 MiB，请减少组数或提示词长度。")
        try: data = json.loads(body)
        except (ValueError, UnicodeError): raise ValueError("请求不是有效 JSON。") from None
        if not isinstance(data, dict): raise ValueError("请求必须为 JSON 对象。")
        return data

    def _candidate(self, data):
        raw = data.get("config")
        if not isinstance(raw, dict): raise ValueError("缺少配置对象。")
        raw = copy.deepcopy(raw)
        problems = shape_errors(raw, schema())
        if problems:
            raise ValueError("；".join(path + "：" + hint for path, hint in problems))
        decision = raw.get("interjection", {}).get("decision", {})
        if decision.get("jev_api_key") == KEEP_SECRET:
            decision["jev_api_key"] = self.plugin.settings.config.decision.jev_api_key
        if not isinstance(raw.get("session_groups", []), list):
            raise ValueError("会话组必须为列表。")
        return Settings(raw)

    async def bootstrap(self):
        try:
            request = self._auth()
            providers = []
            for provider in self.plugin.context.get_all_providers():
                meta = provider.meta()
                providers.append({"id":str(meta.id), "name":str(getattr(meta, "model", "") or meta.id)})
            return self._response({"config":public_config(self.plugin.settings.raw), "schema":self.plugin.settings.schema,
                                   "revision":self.revision(), "providers":providers, "errors":self.plugin.settings.blocking_errors(),
                                   "warnings":self.plugin.settings.warnings, "placeholders":placeholder_catalog(),
                                   "preferences":await self._read_preferences(request.username)})
        except PermissionError as exc: return self._response(error=str(exc))
        except Exception:
            self.plugin.observer.log("warning", "PAGE_READ_FAILED", explanation="无法读取配置或 Provider 列表。")
            return self._response(error="读取配置失败，请查看插件日志。")

    async def status(self):
        try:
            self._auth()
            p = self.plugin
            sessions = []
            targets = set(p.runtime.sessions) | set(p.scopes.targets(p.runtime.sessions))
            for sid in sorted(targets):
                state = p.runtime.sessions.get(sid)
                entry = p._entry_for(sid)
                matched, group = p.scopes.match(sid)
                cfg = entry.config
                today = p._now(sid).date().isoformat()
                sessions.append({"sid":sid, "group":group.name if group else "全局", "matched":matched,
                    "interjection":matched and cfg.enabled and cfg.interjection_enabled and entry.valid("interjection"),
                    "proactive":matched and cfg.enabled and cfg.proactive_enabled and entry.valid("proactive"),
                    "threshold":cfg.threshold, "agent_active":bool(state and state.agent_active),
                    "daily_sent":state.daily_proactive_sent if state and state.last_bot_date == today else 0,
                    "daily_limit":cfg.proactive_daily_limit,
                    "cooldown_remaining":max(0, round(cfg.cooldown_seconds-(time.time()-state.last_bot_at))) if state and state.last_bot_at else 0,
                    "next_run":state.proactive_next_run if state and matched and cfg.enabled and cfg.proactive_enabled and entry.valid("proactive") else None,
                    "latest":p.observer.latest.get(sid), "errors":entry.errors})
            errors = p.settings.blocking_errors()
            if not p._state_valid:
                errors["运行状态"] = {"shared":[["runtime_state.json", "恢复失败；请先备份、检查状态文件并重载。插件已暂停。"]]}
            return self._response({"enabled":p._available(), "global_enabled":p.plugin_config.enabled, "sessions":sessions,
                "warnings":p.settings.warnings,
                "unresolved":p.scopes.unresolved(), "runs":p.traces.list(), "capture_raw":p.traces.capture_raw,
                "errors":errors})
        except PermissionError as exc: return self._response(error=str(exc))
        except Exception: return self._response(error="状态读取失败，请检查配置与服务状态。")

    async def trace(self):
        try:
            request = self._auth()
            run_id = str(request.query.get("run_id", ""))
            if "step" in request.query:
                try:
                    index = int(request.query["step"])
                except (TypeError, ValueError):
                    return self._response(error="步骤编号无效。")
                run = self.plugin.traces.step(run_id, index)
            else:
                run = self.plugin.traces.describe(run_id)
            return self._response(run, error=None if run else "记录已过期、被容量淘汰或不存在。")
        except PermissionError as exc: return self._response(error=str(exc))

    async def preview(self):
        try:
            data = await self._body()
            candidate = self._candidate(data)
            index = data.get("group_index", -1)
            if isinstance(index, bool) or not isinstance(index, int) or index < -1 or index >= len(candidate.groups):
                raise ValueError("会话组索引无效，请刷新配置。")
            entry = candidate.groups[index] if index >= 0 else candidate.global_entry
            return self._response({"effective":public_config(entry.raw), "errors":entry.errors, "warnings":candidate.warnings})
        except (ValueError, PermissionError) as exc: return self._response(error=str(exc))

    async def settings(self):
        try:
            data = await self._body()
            async with self.plugin._settings_lock:
                if data.get("revision") != self.revision():
                    raise ValueError("配置已在另一处变更，请重新载入后再保存，避免覆盖他人的修改。")
                candidate = self._candidate(data)
                if candidate.blocking_errors():
                    return self._response({"errors":candidate.blocking_errors()}, error="配置有误，尚未保存。请查看字段说明。")
                await self.plugin.apply_settings(candidate)
                return self._response({"revision":self.revision(), "config":public_config(candidate.raw)})
        except (ValueError, PermissionError) as exc: return self._response(error=str(exc))
        except Exception as exc:
            self.plugin.observer.error("CONFIG_SAVE_FAILED", exc)
            return self._response(error="配置保存失败，未切换运行配置；请查看日志并重新载入。")

    async def clear(self):
        try:
            await self._body()
            self.plugin.traces.clear()
            return self._response({"cleared":True})
        except (ValueError, PermissionError) as exc: return self._response(error=str(exc))

    @staticmethod
    def _preference_key(username):
        return "console_preferences_" + hashlib.sha256(str(username).encode("utf-8")).hexdigest()

    async def _read_preferences(self, username, *, strict=False):
        try:
            value = await self.plugin.get_kv_data(self._preference_key(username), {})
            return value if isinstance(value, dict) else {}
        except Exception as exc:
            self.plugin.observer.error("PAGE_PREFERENCES_FAILED", exc)
            if strict:
                raise
            return {}

    async def preferences(self):
        """UI-only preferences never save/reload operational plugin settings."""
        try:
            data = await self._body()
            request = self._auth()
            allowed = {"tab": {"overview", "traces", "groups", "interjection", "proactive", "schedule", "context"},
                       "theme": {"auto", "light", "dark"}, "tutorial_seen": {True, False}}
            patch = {}
            for key, value in data.items():
                if key not in allowed or not isinstance(value, (str, bool)) or value not in allowed[key]:
                    raise ValueError("页面偏好字段或取值无效。")
                patch[key] = value
            async with self._prefs_lock:
                prefs = await self._read_preferences(request.username, strict=True)
                prefs.update(patch)
                await self.plugin.put_kv_data(self._preference_key(request.username), prefs)
            return self._response(prefs)
        except (ValueError, PermissionError) as exc:
            return self._response(error=str(exc))
        except Exception as exc:
            self.plugin.observer.error("PAGE_PREFERENCES_FAILED", exc)
            return self._response(error="页面偏好未能保存，当前操作仍有效；请检查插件存储。")
