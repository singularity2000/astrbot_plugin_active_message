"""调用与 AstrBot Future Task 相同的主 Agent 构建器，不自建孤立 LLM。"""
from __future__ import annotations

import asyncio
import copy
import json
from typing import Any

from astrbot.core.agent.tool import FunctionTool
from .native import session_allows_plugin
from .schedule import current_mood
from .prompts import render_template


class SessionBoundSendTool(FunctionTool):
    """仅替换本次请求的发送工具；不修改全局工具实例或核心源码。"""

    def __init__(self, original: Any, plugin: Any, sid: str) -> None:
        super().__init__(name=original.name, description=original.description,
                         parameters=copy.deepcopy(original.parameters), active=original.active)
        self.original = original
        self.plugin = plugin
        self.sid = sid

    async def call(self, context: Any, **kwargs: Any) -> Any:
        target = str(kwargs.get("session") or self.sid)
        if target not in {self.sid, self.sid.split(":", 2)[2]}:
            return "error: proactive chat may send only to its original SID."
        if not self.plugin._available():
            return "error: proactive plugin has been disabled."
        config = self.plugin._config_for(self.sid)
        now = self.plugin._now(self.sid)
        if current_mood(now, config.sleep_hours, config.active_hours) == "睡眠":
            return "error: proactive chat is sleeping."
        state = self.plugin.runtime.get(self.sid)
        if (not context.context.event.get_extra("_active_message_sent", False)
                and state.last_bot_date == now.date().isoformat()
                and state.daily_proactive_sent >= config.proactive_daily_limit):
            return "error: daily proactive limit has been reached."
        kwargs["session"] = self.sid
        return await self.original.call(context, **kwargs)



async def run_proactive_agent(plugin: Any, sid: str, meta: dict[str, Any]) -> None:
    # Imports stay inside the adapter: an older framework can load the plugin's
    # interjection mode even when it lacks the Future Task APIs.
    from astrbot.core.agent.tool import ToolSet
    from astrbot.core.astr_main_agent import MainAgentBuildConfig, _get_session_conv, build_main_agent
    from astrbot.core.config.agent_runner import resolve_context_compression_config
    from astrbot.core.cron.events import CronMessageEvent
    from astrbot.core.pipeline.context_utils import call_event_hook
    from astrbot.core.platform.message_session import MessageSession
    from astrbot.core.provider.entities import ProviderRequest
    from astrbot.core.star.session_llm_manager import SessionServiceManager
    from astrbot.core.star.star_handler import EventType
    from astrbot.core.tools.message_tools import SendMessageToUserTool
    from astrbot.core.utils.history_saver import persist_agent_history
    from astrbot.core.utils.session_lock import session_lock_manager

    config = plugin._config_for(sid)
    context = plugin.context
    session = MessageSession.from_str(sid)
    event = CronMessageEvent(
        context=context, session=session, message="主动聊天时机已到。",
        extras={"_active_message_meta": meta}, message_type=session.message_type,
    )
    event.role = "member"
    event.message_obj.sender.user_id = "active_message_scheduler"
    event.message_obj.sender.nickname = "主动会话 Bot"
    cfg = context.get_config(umo=sid)
    selected = cfg.get("plugin_set", ["*"])
    event.plugins_name = None if selected == ["*"] else selected
    runner = None
    async with session_lock_manager.acquire_lock(sid):
        if not plugin.proactive_allowed_now(sid) or not session_allows_plugin(context, sid, plugin.PLUGIN_ID):
            plugin.observer.log("info", "PROACTIVE_SKIPPED", sid=sid, run_id=meta["run_id"])
            return
        if not await SessionServiceManager.should_process_llm_request(event):
            plugin.observer.log("info", "SESSION_LLM_DISABLED", sid=sid, run_id=meta["run_id"])
            return
        cfg = context.get_config(umo=sid)
        if cfg.get("agent_runner", {}).get("runner_type", "local") != "local":
            plugin.observer.log("warning", "PROACTIVE_RUNNER_UNSUPPORTED", sid=sid, run_id=meta["run_id"])
            return
        settings = cfg.get("provider_settings", {})
        runner_settings = cfg.get("agent_runner", {}).get("config", {})
        persona_settings = runner_settings.get("persona", {})
        misc = runner_settings.get("misc", {})
        model = runner_settings.get("model", {})
        build_cfg = MainAgentBuildConfig(
            tool_call_timeout=max(1, int(misc.get("tool_call_timeout", 120))),
            tool_schema_mode=misc.get("tool_schema_mode", "full"),
            streaming_response=False,
            **resolve_context_compression_config(runner_settings.get("compression", {})),
            llm_safety_mode=persona_settings.get("safety_mode", True),
            safety_mode_strategy=persona_settings.get("safety_mode_strategy", "system_prompt"),
            computer_use_runtime=settings.get("computer_use_runtime", "none"),
            sandbox_cfg=settings.get("sandbox", {}),
            provider_settings=settings,
            fallback_provider_ids=model.get("fallback_provider_ids", []),
            request_max_retries=model.get("request_max_retries", 5),
            kb_agentic_mode=cfg.get("kb_agentic_mode", False),
            subagent_orchestrator=cfg.get("subagent_orchestrator", {}),
            timezone=config.timezone or cfg.get("timezone"),
        )
        conversation = await _get_session_conv(event, context)
        values = await plugin._values(event, conversation, "主动聊天")
        values.update(model_score="不适用", score="不适用", decision_reason="定时主动聊天")
        meta["values"] = values
        request = ProviderRequest(
            prompt=render_template(config.proactive_task_prompt, values) + "\n若要发送，必须使用 send_message_to_user；只能发送至当前 SID。",
            conversation=conversation,
            contexts=json.loads(conversation.history or "[]"),
            func_tool=ToolSet(),
        )
        request.func_tool.add_tool(context.get_llm_tool_manager().get_builtin_tool(SendMessageToUserTool))
        result = await build_main_agent(event=event, plugin_context=context, config=build_cfg, req=request, apply_reset=False)
        if result is None:
            plugin.observer.log("warning", "PROACTIVE_AGENT_BUILD_FAILED", sid=sid, run_id=meta["run_id"])
            return
        runner = result.agent_runner
        reset = result.reset_coro
        try:
            if await call_event_hook(event, EventType.OnLLMRequestEvent, result.provider_request):
                return
            # Bind just this request's sender tool after the native hooks/build,
            # leaving the global tool registry and all other native tools intact.
            native_tools = result.provider_request.func_tool
            send_tool = native_tools.get_tool("send_message_to_user") if native_tools else None
            if send_tool is None:
                plugin.observer.log("warning", "PROACTIVE_SEND_TOOL_MISSING", sid=sid, run_id=meta["run_id"])
                return
            bounded = ToolSet(list(native_tools.tools))
            bounded.add_tool(SessionBoundSendTool(send_tool, plugin, sid))
            result.provider_request.func_tool = bounded
            # Never borrow a sender's authority, including changes by other hooks.
            event.role = "member"
            if reset is not None:
                await reset
                reset = None
            plugin.runtime.get(sid).agent_active = True
            plugin.observer.log("info", "AGENT_STARTED", sid=sid, run_id=meta["run_id"], role="member", trigger_type="主动聊天")
            async with asyncio.timeout(config.proactive_timeout_seconds):
                async for _ in runner.step_until_done(max(1, int(misc.get("max_steps", 128)))):
                    pass
            response = runner.get_final_llm_resp()
            if getattr(getattr(runner, "state", None), "name", "") == "ERROR":
                raise RuntimeError("NATIVE_AGENT_ERROR")
            summary = "[主动会话] " + (getattr(response, "completion_text", "") or "本次未产生最终文本。")
            await persist_agent_history(context.conversation_manager, event=event, req=result.provider_request, summary_note=summary)
            plugin.traces.add(meta["run_id"], "主动任务历史已交由原生接口保存", {"conversation_id":getattr(conversation,"cid",None)})
            if not event.get_extra("_active_message_sent", False):
                plugin.observer.log("info", "PROACTIVE_NO_SEND", sid=sid, run_id=meta["run_id"])
        finally:
            if reset is not None:
                reset.close()
            if runner is not None and not runner.done():
                runner.request_stop()
            plugin.runtime.get(sid).agent_active = False
