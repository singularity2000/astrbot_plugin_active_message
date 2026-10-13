"""使用原生 Pages 的登录校验与接口，不另起服务器，不公开原始日志。"""
from __future__ import annotations
import asyncio
from datetime import datetime

import copy
import hashlib
import json
import time
from .agenda import config_only
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
        for name in ("bootstrap", "status", "trace", "settings", "preview", "preferences", "redistribute"):
            handler = getattr(self, name)
            self.handlers.append(handler)
            self.plugin.context.register_web_api(f"/{self.plugin.PLUGIN_ID}/{name}", handler,
                ["POST"] if name in {"settings", "preview", "preferences", "redistribute"} else ["GET"], "主动会话运行检查台")

    def unregister(self):
        registry = self.plugin.context.registered_web_apis
        registry[:] = [api for api in registry if api[1] not in self.handlers]

    def revision(self):
        store = self.plugin.agenda_store
        return hashlib.sha256(json.dumps({"config": config_only(self.plugin.config_raw),
            "agenda_revision": store.revision, "events": store.events},
            sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()

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
        if not isinstance(raw.get("agenda"), dict) or "events" not in raw["agenda"]:
            raise ValueError("日程草稿不完整，请重新载入；不会用空列表替换已有日程。")
        problems = shape_errors(raw, schema())
        if problems:
            raise ValueError("；".join(path + "：" + hint for path, hint in problems))
        decision = raw.get("interjection", {}).get("decision", {})
        if decision.get("jev_api_key") == KEEP_SECRET:
            decision["jev_api_key"] = self.plugin.settings.config.decision.jev_api_key
        if not isinstance(raw.get("session_groups", []), list):
            raise ValueError("会话组必须为列表。")
        candidate = Settings(raw)
        candidate.agenda_revision = self.plugin.agenda_store.revision
        candidate.config_revision = self.plugin.agenda_store.config_revision(self.plugin.config_raw)
        return candidate

    async def bootstrap(self):
        try:
            request = self._auth()
            async with self.plugin._settings_lock:
                await self.plugin.agenda_store.check_current()
                config = public_config(self.plugin.settings.raw)
                metadata = copy.deepcopy(self.plugin.settings.schema)
                revision = self.revision()
            providers = []
            for provider in self.plugin.context.get_all_providers():
                meta = provider.meta()
                providers.append({"id":str(meta.id), "name":str(getattr(meta, "model", "") or meta.id)})
            return self._response({"config":config, "schema":metadata,
                                   "revision":revision, "providers":providers, "errors":self.plugin.settings.blocking_errors(),
                                   "warnings":self.plugin.settings.warnings, "placeholders":placeholder_catalog(),
                                   "preferences":await self._read_preferences(request.username)})
        except (ValueError, PermissionError) as exc: return self._response(error=str(exc))
        except Exception:
            self.plugin.observer.log("warning", "PAGE_READ_FAILED", explanation="无法读取配置或 Provider 列表。")
            return self._response(error="读取配置失败，请查看插件日志。")

    async def status(self):
        try:
            request = self._auth()
            schedule_sid = str(request.query.get("schedule_sid", ""))
            p = self.plugin
            sessions = []
            targets = set(p.runtime.sessions) | set(p.scopes.targets(p.runtime.sessions))
            for sid in sorted(targets):
                state = p.runtime.sessions.get(sid)
                entry = p._entry_for(sid)
                matched, group = p.scopes.match(sid)
                group_index = next((i for i, item in enumerate(p.plugin_config.groups) if item is group), None)
                cfg = entry.config
                now = p._now(sid)
                today = now.date().isoformat()
                scheduled = bool(state and matched and cfg.enabled and cfg.proactive_enabled and entry.valid("proactive") and p._available())
                sessions.append({"sid":sid, "group":group.name if group else "全局", "matched":matched,
                    "group_id":p.settings.raw["session_groups"][group_index]["agenda_id"] if group_index is not None else None,
                    "group_index":group_index,
                    "interjection":matched and cfg.enabled and cfg.interjection_enabled and entry.valid("interjection"),
                    "proactive":matched and cfg.enabled and cfg.proactive_enabled and entry.valid("proactive"),
                    "threshold":cfg.threshold, "agent_active":bool(state and state.agent_active),
                    "daily_sent":state.daily_proactive_sent if state and state.last_bot_date == today else 0,
                    "daily_limit":cfg.proactive_daily_limit,
                    "cooldown_remaining":max(0, round(cfg.cooldown_seconds-(time.time()-state.last_bot_at))) if state and state.last_bot_at else 0,
                    "next_run":state.proactive_next_run if state and matched and cfg.enabled and cfg.proactive_enabled and entry.valid("proactive") else None,
                    "schedule_date":state.proactive_schedule_date if scheduled else today,
                    "schedule":state.proactive_schedule if scheduled and sid == schedule_sid and state.proactive_schedule_date == today else [],
                    "schedule_timezone":str(now.tzinfo),
                    "reallocation":p.proactive_reallocation(sid) if sid == schedule_sid else None,
                    "latest":p.observer.latest.get(sid), "errors":entry.errors})
            errors = p.settings.blocking_errors()
            if not p._state_valid:
                errors["运行状态"] = {"shared":[["runtime_state.json", "恢复失败；请先备份、检查状态文件并重载。插件已暂停。"]]}
            if not p.agenda_store.ready:
                errors["日程存储"] = {"agenda":[["agenda.json", "日程存储未就绪或事务未完成；请检查日志后重载，勿回写旧文件。"]]}
            runs = p.traces.list()
            for run in runs:
                _, owner = p.scopes.match(run["sid"])
                run["group_index"] = next((i for i, item in enumerate(p.plugin_config.groups) if item is owner), None)
            return self._response({"enabled":p._available(), "global_enabled":p.plugin_config.enabled, "sessions":sessions,
                "groups":[{"index":i, "name":group.name, "key":"group:" + p.settings.raw["session_groups"][i]["agenda_id"]} for i, group in enumerate(p.plugin_config.groups)],
                "warnings":p.settings.warnings,
                "unresolved":p.scopes.unresolved(), "runs":runs, "capture_raw":p.traces.capture_raw,
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
            result = {"effective":public_config(entry.raw), "errors":entry.errors, "warnings":candidate.warnings}
            # 作息时间轴与日历使用同一预览时区，不能依赖浏览器所在时区。
            from .schedule import get_timezone
            sid = candidate.config.groups[index].sids[0] if index >= 0 and candidate.config.groups[index].sids else None
            timezone_name = entry.config.timezone or self.plugin.context.get_config(umo=sid).get("timezone", "") or ""
            try:
                preview_timezone = get_timezone(timezone_name)
            except (KeyError, ValueError):
                preview_timezone = get_timezone("")
            result["schedule_clock"] = {"now":datetime.now(preview_timezone).isoformat(),
                                        "timezone":timezone_name or str(preview_timezone)}
            if candidate.agenda_catalog_errors:
                result["errors"] = {**result["errors"], "agenda_catalog": candidate.agenda_catalog_errors}
            if "calendar_month" in data:
                from .agenda import Agenda
                from .schedule import get_timezone
                candidate.scopes.inherit_observations(self.plugin.scopes)
                # The card list retains its editing scope when the calendar is
                # narrowed to a SID. Date filtering is a separate projection.
                list_catalog = copy.deepcopy(entry.raw["agenda"])
                known = {e.get("id") for e in list_catalog["events"]}
                list_catalog["events"].extend(e for e in candidate.raw["agenda"]["events"]
                    if not e.get("group_id") and not e.get("target_sids") and e.get("id") not in known)
                list_catalog["events"].extend(e for e in candidate.raw["agenda"]["events"] if e.get("target_sids") and
                    (index < 0 or any(candidate.scopes.match(sid)[1] is candidate.config.groups[index] for sid in e["target_sids"])))
                if index < 0:
                    group_ids = {g.get("agenda_id") for g in candidate.raw["session_groups"]}
                    list_catalog["events"].extend(e for e in candidate.raw["agenda"]["events"] if e.get("group_id") and e["group_id"] not in group_ids)
                list_timezone = entry.config.timezone
                list_sid = candidate.config.groups[index].sids[0] if index >= 0 and candidate.config.groups[index].sids else None
                list_name = list_timezone or self.plugin.context.get_config(umo=list_sid).get("timezone", "") or ""
                try:
                    list_now = datetime.now(get_timezone(list_name))
                except (KeyError, ValueError):
                    list_now = datetime.now(get_timezone(""))
                result["agenda_list"] = await asyncio.to_thread(
                    Agenda(list_catalog, timezone_name=list_timezone, max_events=1000).list_preview,
                    list_now, start_date=data.get("agenda_start_date", ""), end_date=data.get("agenda_end_date", ""))
                selected_sid = data.get("calendar_sid", "")
                if not isinstance(selected_sid, str):
                    raise ValueError("日历会话筛选需要完整 SID。")
                if selected_sid:
                    from .sessions import split_sid
                    split_sid(selected_sid)
                    entry = candidate.for_sid(selected_sid)
                    calendar_agenda = entry.agenda
                else:
                    catalog = copy.deepcopy(entry.raw["agenda"])
                    targeted = [e for e in candidate.raw["agenda"]["events"] if e.get("target_sids") and
                                (index < 0 or any(candidate.scopes.match(sid)[1] is candidate.config.groups[index]
                                                  for sid in e["target_sids"]))]
                    catalog["events"].extend(targeted)
                    origins = {e["id"]: "本组" for e in catalog["events"] if e.get("group_id")}
                    origins.update({e["id"]: "指定会话：" + "、".join(e["target_sids"]) for e in targeted})
                    calendar_agenda = Agenda(catalog, origins=origins, timezone_name=entry.config.timezone, max_events=1000)
                sid = selected_sid or (candidate.config.groups[index].sids[0] if index >= 0 and candidate.config.groups[index].sids else None)
                name = entry.config.timezone or self.plugin.context.get_config(umo=sid).get("timezone", "") or ""
                try:
                    tz = get_timezone(name)
                except (KeyError, ValueError):
                    tz = get_timezone("")
                now = datetime.now(tz)
                result["calendar"] = calendar_agenda.month(data["calendar_month"] or now.strftime("%Y-%m"), now)
                result["calendar"]["timezone_note"] = "未单独设置时区时，以本组首个 SID 的框架时区预览；实际各会话使用自己的时区。" if index >= 0 else "未单独设置时区时，以框架默认时区预览。"
            return self._response(result)
        except (ValueError, PermissionError) as exc: return self._response(error=str(exc))

    async def redistribute(self):
        try:
            data = await self._body()
            sid, revision = data.get("sid"), data.get("schedule_revision")
            if not isinstance(sid, str) or not isinstance(revision, str) or not revision:
                raise ValueError("缺少会话或预约信息，请刷新后重试。")
            from .sessions import split_sid
            split_sid(sid)
            async with self.plugin._settings_lock:
                await self.plugin.agenda_store.check_current()
                if data.get("revision") != self.revision():
                    raise ValueError("设置或日程已经变更，请重新载入后再重新分配。")
                result = await self.plugin.redistribute_proactive(sid, revision)
            return self._response(result)
        except (ValueError, PermissionError) as exc:
            return self._response(error=str(exc))
        except Exception as exc:
            self.plugin.observer.error("PROACTIVE_REALLOCATION_FAILED", exc)
            return self._response(error="重新分配未完成，请刷新确认当前预约，并检查插件日志。")

    async def settings(self):
        try:
            data = await self._body()
            async with self.plugin._settings_lock:
                await self.plugin.agenda_store.check_current()
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
            return self._response(error="保存未完成，日程可能已安全落盘；请查看日志并重载恢复，不要用旧草稿覆盖。")

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
                       "theme": {"auto", "light", "dark"}, "tutorial_seen": {True, False}, "trace_live": {True, False}, "overview_live": {True, False}}
            patch = {}
            for key, value in data.items():
                if key == "agenda_page_size":
                    if type(value) is not int or not 1 <= value <= 100:
                        raise ValueError("每页日程数量需要 1～100 的整数。")
                elif key in {"trace_kinds", "trace_results"}:
                    choices = {"ordinary", "other", "interjection", "proactive"} if key == "trace_kinds" else {"running", "sent", "quiet", "error"}
                    if not isinstance(value, list) or len(value) > 4 or any(not isinstance(v, str) or v not in choices for v in value):
                        raise ValueError("回放多选筛选值无效。")
                    value = list(dict.fromkeys(value))
                elif key == "trace_minutes":
                    if type(value) is not int or value not in {0, 5, 30, 60, 180, 360, 720, 1440}:
                        raise ValueError("回放时间范围无效。")
                elif key in {"trace_group", "trace_sid"}:
                    if not isinstance(value, str) or len(value) > (100 if key == "trace_group" else 1000):
                        raise ValueError("回放会话筛选值无效或过长。")
                elif key not in allowed or not isinstance(value, (str, bool)) or value not in allowed[key]:
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
