"""原生 Agent 主动聊天、发送限制、执行阶段跟踪与取消清理。"""
from __future__ import annotations

import copy
import json
import asyncio
import time
from typing import Any
from astrbot.core.agent.tool import FunctionTool
from .native import session_allows_plugin
from .prompts import render_template
from .diagnostics import exception_details


class _SendContextProxy:
    """Delegate native media preparation; guard only this call's final send."""

    def __init__(self, original: Any, tool: Any, event: Any, progress: Any) -> None:
        self._original = original
        self._tool, self._event, self._progress = tool, event, progress
        self.skipped_result: str | None = None
        self.native_skipped_result: str | None = None

    def __getattr__(self, name: str) -> Any:
        return getattr(self._original, name)

    async def send_message(self, session: Any, message_chain: Any) -> Any:
        if self._progress:
            self._progress.check_deadline()
        reason = self._tool._block_reason(self._event, str(session))
        if reason:
            self.skipped_result = self._tool._skip(self._event, reason, "before_send")
            # v4.28.2 and the current native tool immediately return this text
            # on False, without setting delivery flags. Translate only this
            # known result outside the native call; real errors still propagate.
            self.native_skipped_result = f"error: failed to find platform for session {session}."
            return False
        return await self._original.send_message(session, message_chain)


class SessionBoundSendTool(FunctionTool):
    """仅替换本次请求的发送工具；不修改全局工具实例或核心源码。"""

    def __init__(self, original: Any, plugin: Any, sid: str, feature: str = "proactive") -> None:
        super().__init__(name=original.name, description=original.description,
                         parameters=copy.deepcopy(original.parameters), active=original.active)
        self.original = original
        self.plugin = plugin
        self.sid = sid
        self.feature = feature

    def _block_reason(self, event: Any, target: str) -> str:
        if target != self.sid or event.unified_msg_origin != self.sid:
            return "发送目标或当前上下文已偏离原会话"
        if not self.plugin._available():
            return "插件已停用或暂不可用"
        config = self.plugin._config_for(self.sid)
        if (not config.enabled or not getattr(config, self.feature + "_enabled")
                or not self.plugin._feature_valid(self.sid, self.feature)):
            return "本会话自主发言已关闭或配置无效"
        if not self.plugin.scopes.match(self.sid)[0]:
            return "本会话已不在插件生效范围内"
        if not session_allows_plugin(self.plugin.context, self.sid, self.plugin.PLUGIN_ID):
            return "主框架已禁止本会话使用插件或 LLM"
        now = self.plugin._now(self.sid)
        agenda_reason = self.plugin._agenda_block(self.sid, self.feature)
        if agenda_reason:
            return "自主发言已暂停：" + agenda_reason
        state = self.plugin.runtime.get(self.sid)
        if (self.feature == "proactive" and not event.get_extra("_active_message_sent", False)
                and state.last_bot_date == now.date().isoformat()
                and state.daily_proactive_sent >= config.proactive_daily_limit):
            return "本会话已用完今日主动尝试额度"
        return ""

    def _skip(self, event: Any, reason: str, checkpoint: str) -> str:
        meta = event.get_extra("_active_message_meta", {})
        meta["suppression_reason"] = reason
        progress = meta.get("progress")
        if progress:
            progress.outcome = "主动发送已放弃：" + reason
        self.plugin.observer.log(
            "info", "PROACTIVE_SEND_SKIPPED", sid=self.sid, run_id=meta.get("run_id"),
            reason=reason, checkpoint=checkpoint, tool=self.name,
            message="主动发送已放弃：" + reason,
        )
        return "主动发送已放弃：" + reason + "。请结束本轮主动聊天，不要重试发送。"

    async def call(self, context: Any, **kwargs: Any) -> Any:
        event = context.context.event
        target = str(kwargs.get("session") or self.sid)
        if target == self.sid.split(":", 2)[2]:
            target = self.sid
        reason = self._block_reason(event, target)
        if reason:
            return self._skip(event, reason, "before_prepare")
        kwargs["session"] = self.sid
        meta = event.get_extra("_active_message_meta", {})
        progress = meta.get("progress")
        if progress:
            progress.check_deadline()
            progress.enter("send", tool=self.name)
        # Both are native mutable dataclasses. Shallow copies preserve event,
        # history and extras identities, while isolating the Context reference
        # from this runner's other tools and all other concurrent runs.
        local_context = copy.copy(context)
        local_context.context = copy.copy(context.context)
        proxy = _SendContextProxy(context.context.context, self, event, progress)
        local_context.context.context = proxy
        result = await self.original.call(local_context, **kwargs)
        if proxy.skipped_result is not None and result == proxy.native_skipped_result:
            result = proxy.skipped_result
        if progress:
            from .native import tool_response_text
            if tool_response_text(result).startswith("Message sent to session "):
                # Keep delivery evidence even if a later hook/history write fails.
                progress.sent = True
                event = context.context.event
                # Share the native response hook's deduplication key. Record
                # confirmed delivery before other hooks or deadline checks can
                # interrupt this return path; the later hook becomes a no-op.
                await self.plugin._record_sent(
                    event, f"tool:{id(event)}:{event.get_extra('_active_message_send_seq', 0)}")
            elif tool_response_text(result).lower().startswith("error"):
                progress.failure("PROACTIVE_TOOL_FAILED", tool=self.name, send_returned_error=True)
            progress.enter("tool", tool=self.name)
        return result



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
    progress: RunProgress = meta["progress"]
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
    progress.enter("session_lock")
    async with session_lock_manager.acquire_lock(sid):
        progress.enter("checks")
        if not plugin.proactive_allowed_now(sid) or not session_allows_plugin(context, sid, plugin.PLUGIN_ID):
            progress.outcome = "跳过：运行条件已变化"
            plugin.observer.log("debug", "PROACTIVE_SKIPPED", sid=sid, run_id=meta["run_id"])
            return
        if not await SessionServiceManager.should_process_llm_request(event):
            progress.outcome = "跳过：会话 LLM 已关闭"
            plugin.observer.log("info", "SESSION_LLM_DISABLED", sid=sid, run_id=meta["run_id"])
            return
        cfg = context.get_config(umo=sid)
        if cfg.get("agent_runner", {}).get("runner_type", "local") != "local":
            progress.outcome = "跳过：不支持的 Agent 类型"
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
        progress.enter("conversation")
        conversation = await _get_session_conv(event, context)
        progress.enter("context")
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
        progress.enter("build", tool_timeout_seconds=build_cfg.tool_call_timeout,
                       request_max_retries=build_cfg.request_max_retries)
        result = await build_main_agent(event=event, plugin_context=context, config=build_cfg, req=request, apply_reset=False)
        if result is None:
            progress.outcome = "失败：原生 Agent 构建未完成"
            plugin.observer.log("warning", "PROACTIVE_AGENT_BUILD_FAILED", sid=sid, run_id=meta["run_id"])
            return
        runner = result.agent_runner
        reset = result.reset_coro
        try:
            progress.enter("request_hooks")
            if await call_event_hook(event, EventType.OnLLMRequestEvent, result.provider_request):
                progress.outcome = "跳过：原生请求钩子停止执行"
                return
            # Bind just this request's sender tool after the native hooks/build,
            # leaving the global tool registry and all other native tools intact.
            native_tools = result.provider_request.func_tool
            send_tool = native_tools.get_tool("send_message_to_user") if native_tools else None
            if send_tool is None:
                progress.outcome = "失败：原生发送工具不可用"
                plugin.observer.log("warning", "PROACTIVE_SEND_TOOL_MISSING", sid=sid, run_id=meta["run_id"])
                return
            bounded = ToolSet(list(native_tools.tools))
            bounded.add_tool(SessionBoundSendTool(send_tool, plugin, sid))
            result.provider_request.func_tool = bounded
            # Never borrow a sender's authority, including changes by other hooks.
            event.role = "member"
            if reset is not None:
                progress.enter("reset")
                await reset
                reset = None
            observe_runner(runner, progress)
            plugin.runtime.get(sid).agent_active = True
            plugin.observer.log("debug", "AGENT_STARTED", sid=sid, run_id=meta["run_id"], role="member", trigger_type="主动聊天")
            progress.enter("agent")
            async for response_event in runner.step_until_done(max(1, int(misc.get("max_steps", 128)))):
                pass  # Native retries/fallbacks determine the final runner state.
            response = runner.get_final_llm_resp()
            if getattr(getattr(runner, "state", None), "name", "") == "ERROR":
                raise NativeAgentError("NATIVE_AGENT_ERROR")
            if getattr(getattr(runner, "state", None), "name", "") != "DONE":
                raise NativeAgentError("NATIVE_AGENT_NOT_COMPLETED")
            summary = "[主动会话] " + (getattr(response, "completion_text", "") or "本次未产生最终文本。")
            progress.enter("history")
            await persist_agent_history(context.conversation_manager, event=event, req=result.provider_request, summary_note=summary)
            plugin.traces.add(meta["run_id"], "主动任务历史已交由原生接口保存", {"conversation_id":getattr(conversation,"cid",None)})
            suppression_reason = meta.get("suppression_reason")
            if not event.get_extra("_active_message_sent", False) and not suppression_reason:
                plugin.observer.log("debug", "PROACTIVE_NO_SEND", sid=sid, run_id=meta["run_id"])
            progress.sent = progress.sent or event.get_extra("_active_message_sent", False)
            if suppression_reason:
                progress.outcome = ("已发送部分消息；后续主动发送已放弃：" if progress.sent
                                    else "主动发送已放弃：") + suppression_reason
            else:
                progress.outcome = "已发送，任务完成" if progress.sent else "正常完成，未发送"
            progress.enter("complete")
            # 不依赖任何第三方“不回复”工具；只认原生 Agent 的整轮完成状态。
            progress.completed = not bool(suppression_reason)
        finally:
            try:
                if reset is not None:
                    reset.close()
                if runner is not None and getattr(runner, "state", None) is not None and not runner.done():
                    runner.request_stop()
            finally:
                try:
                    await progress.cancel_tools()
                finally:
                    # This must also run on a second cancellation during cleanup.
                    remaining = {task for task in progress.active_tools if not task.done()}
                    if remaining:
                        # Third-party tools can ignore cancellation. Pause rather
                        # than start another proactive turn over unfinished work.
                        plugin._valid = False
                        plugin._unfinished_tools.update(remaining)
                        def forget(task):
                            plugin._unfinished_tools.discard(task)
                            if not task.cancelled():
                                task.exception()
                        for task in remaining:
                            task.add_done_callback(forget)
                    plugin.runtime.get(sid).agent_active = False


PHASES = {
    "queue": "等待主动任务名额", "session_lock": "等待原生会话锁",
    "checks": "检查会话运行条件", "conversation": "读取原生对话分支",
    "context": "准备人格与聊天参考资料", "build": "构建原生 Agent",
    "request_hooks": "执行原生请求钩子", "reset": "初始化原生 Agent",
    "agent": "原生 Agent 调度／重试", "context_processing": "原生上下文整理／压缩",
    "agent_hooks": "执行原生 Agent／工具钩子",
    "llm": "等待聊天模型返回", "tool": "执行原生工具",
    "send": "执行原生发送工具（含媒体准备及平台发送）",
    "history": "保存原生对话历史", "complete": "执行结束",
}


class NativeAgentError(RuntimeError):
    """原生 Agent 返回失败或未确认完成；不能当作正常完成来消耗额度。"""


class RunProgress:
    def __init__(self, observer: Any, sid: str, run_id: str, timeout: float | None) -> None:
        self.observer, self.sid, self.run_id = observer, sid, run_id
        self.started = self.phase_started = time.monotonic()
        self.phase = "queue"
        self.details: dict[str, Any] = {}
        self.timings: dict[str, float] = {}
        self.timeout = timeout
        self.calls = 0
        self.tools = 0
        self.sent = False
        self.completed = False
        self.outcome = ""
        self.last_failure: dict[str, Any] | None = None
        self.deadline_at: float | None = None
        self.active_tools: set[asyncio.Task] = set()
        self.cleanup_completed = False
        self.cleanup_seconds = 0.0
        self.owner_task = asyncio.current_task()

    def check_deadline(self) -> None:
        # Some framework hook dispatchers swallow CancelledError. Recheck at
        # native-operation boundaries so a swallowed cancellation cannot start
        # another model request or send after the budget has elapsed.
        if self.deadline_at is not None and time.monotonic() >= self.deadline_at:
            raise TimeoutError("PROACTIVE_DEADLINE_EXCEEDED")
        # An unload/settings cancellation may happen before the time budget.
        # Native hook dispatch can swallow it, but Task.cancelling keeps evidence.
        current = asyncio.current_task()
        if any(task is not None and task.cancelling() for task in (self.owner_task, current)):
            raise asyncio.CancelledError

    async def cancel_tools(self) -> None:
        # AstrBot 4.28.2 can orphan the task awaiting a tool iterator when the
        # runner is cancelled. Track only our own executor tasks, never all_tasks.
        started = time.monotonic()
        pending = [task for task in self.active_tools
                   if task is not asyncio.current_task() and not task.done()]
        for task in pending:
            task.cancel()
        try:
            if pending:
                done, _ = await asyncio.wait(pending, timeout=5)
                for task in done:
                    if not task.cancelled():
                        task.exception()  # Retrieve failures without exposing text.
        finally:
            # A reload can cancel us again while cleanup is waiting. Always
            # expose unfinished work, even when this wait itself is cancelled.
            remaining = [task for task in pending if not task.done()]
            self.cleanup_seconds = round(time.monotonic() - started, 3)
            self.cleanup_completed = not remaining
            if remaining:
                self.emit("PROACTIVE_CLEANUP_PENDING", "error", pending_tools=len(remaining))

    def emit(self, code: str, level: str = "debug", **fields: Any) -> None:
        self.observer.log(level, code, sid=self.sid, run_id=self.run_id, **fields)

    def enter(self, phase: str, **details: Any) -> None:
        self.check_deadline()
        now = time.monotonic()
        self.timings[self.phase] = self.timings.get(self.phase, 0) + now - self.phase_started
        self.phase, self.phase_started, self.details = phase, now, details
        self.emit("PROACTIVE_PROGRESS", **self.snapshot())

    def snapshot(self) -> dict[str, Any]:
        now = time.monotonic()
        durations = dict(self.timings)
        durations[self.phase] = durations.get(self.phase, 0) + now - self.phase_started
        return {"phase": self.phase, "phase_label": PHASES.get(self.phase, self.phase),
                "phase_seconds": round(now - self.phase_started, 3),
                "elapsed_seconds": round(now - self.started, 3),
                "execution_seconds": round(max(0, now - self.started - durations.get("queue", 0)), 3),
                "timeout_seconds": self.timeout,
                "phase_totals_seconds": {k: round(v, 3) for k, v in durations.items()},
                "provider_calls": self.calls, "tool_calls": self.tools,
                "tracked_tools_cleanup_completed": self.cleanup_completed,
                "cleanup_seconds": self.cleanup_seconds,
                "sent": self.sent, **self.details,
                **({"last_failure": self.last_failure} if self.last_failure else {})}

    def failure(self, code: str, exc: BaseException | None = None, **fields: Any) -> None:
        self.last_failure = {"phase": self.phase, **self.details, **fields,
                             **(exception_details(exc) if exc else {})}
        self.emit(code, "warning", **self.last_failure)


class _Delegate:
    def __init__(self, original: Any, progress: RunProgress) -> None:
        self.original, self.progress = original, progress

    def __getattr__(self, name: str) -> Any:
        return getattr(self.original, name)


class _ObservedProvider(_Delegate):
    """Only installed on this runner, never on the shared provider registry."""

    async def text_chat(self, *args: Any, **kwargs: Any) -> Any:
        p = self.progress
        p.check_deadline()
        p.calls += 1
        provider_config = getattr(self.original, "provider_config", {})
        provider_id = str(provider_config.get("id", ""))[:160]
        model = kwargs.get("model") or self.original.get_model()
        p.enter("llm", provider_id=provider_id, model=str(model)[:160], call=p.calls)
        p.emit("PROACTIVE_LLM_STARTED", **p.details,
               request_max_retries=kwargs.get("request_max_retries"))
        start = time.monotonic()
        try:
            response = await self.original.text_chat(*args, **kwargs)
        except asyncio.CancelledError:
            # Preserve the in-flight phase for the enclosing deadline report.
            raise
        except Exception as exc:
            p.failure("PROACTIVE_LLM_ATTEMPT_ERROR", exc, call_seconds=round(time.monotonic() - start, 3))
            p.enter("agent")
            raise
        role = getattr(response, "role", None)
        p.emit("PROACTIVE_LLM_FINISHED", **p.details, response_role=role,
               call_seconds=round(time.monotonic() - start, 3),
               requested_tools=len(getattr(response, "tools_call_name", None) or []))
        if role == "err":
            p.failure("PROACTIVE_LLM_ATTEMPT_ERROR", response_role="err")
        p.enter("agent")
        return response


class _ObservedContext(_Delegate):
    async def process(self, *args: Any, **kwargs: Any) -> Any:
        self.progress.check_deadline()
        self.progress.enter("context_processing")
        result = await self.original.process(*args, **kwargs)
        self.progress.enter("agent")
        return result


class _ObservedExecutor(_Delegate):
    async def execute(self, *args: Any, **kwargs: Any):
        p = self.progress
        p.check_deadline()
        p.tools += 1
        tool = kwargs.get("tool", args[0] if args else None)
        name = str(getattr(tool, "name", ""))[:160]
        p.enter("tool", tool=name, tool_call=p.tools)
        iterator = self.original.execute(*args, **kwargs)
        try:
            while True:
                task = asyncio.current_task()
                if task is not None:
                    p.active_tools.add(task)
                try:
                    response = await anext(iterator)
                except StopAsyncIteration:
                    break
                finally:
                    p.active_tools.discard(task)
                # Native tools often return an "error:" text block without
                # setting MCP's isError flag. Classify only the prefix, not text.
                parts = getattr(response, "content", None)
                error_prefix = isinstance(parts, list) and any(
                    isinstance(getattr(part, "text", None), str)
                    and part.text.lstrip().lower().startswith("error:") for part in parts)
                if getattr(response, "isError", False) or error_prefix:
                    p.failure("PROACTIVE_TOOL_FAILED", tool=name, result_is_error=bool(getattr(response, "isError", False)),
                              result_error_prefix=bool(error_prefix))
                yield response
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            p.failure("PROACTIVE_TOOL_FAILED", exc, tool=name)
            p.enter("agent")
            raise
        else:
            p.enter("agent")
        finally:
            close = getattr(iterator, "aclose", None)
            if close is not None:
                await close()


class _ObservedHooks(_Delegate):
    async def _call(self, name: str, *args: Any) -> None:
        self.progress.check_deadline()
        self.progress.enter("agent_hooks", hook=name)
        await getattr(self.original, name)(*args)
        self.progress.check_deadline()
        self.progress.enter("agent")

    async def on_agent_begin(self, *args: Any) -> None:
        await self._call("on_agent_begin", *args)

    async def on_agent_done(self, *args: Any) -> None:
        await self._call("on_agent_done", *args)

    async def on_tool_start(self, *args: Any) -> None:
        await self._call("on_tool_start", *args)

    async def on_tool_end(self, *args: Any) -> None:
        await self._call("on_tool_end", *args)


def observe_runner(runner: Any, progress: RunProgress) -> None:
    """Native local runner adapter, verified against AstrBot v4.28.2.

    The proactive adapter explicitly disables streaming. Provider-level calls
    include SDK retries; these counters are NOT individual HTTP attempts.
    Compression stays inside its own phase, including any summarizing model.
    """
    if getattr(runner, "provider", None) is not None:
        runner.provider = _ObservedProvider(runner.provider, progress)
    if hasattr(runner, "fallback_providers"):
        runner.fallback_providers = [_ObservedProvider(p, progress) for p in runner.fallback_providers]
    if getattr(runner, "request_context_manager", None) is not None:
        runner.request_context_manager = _ObservedContext(runner.request_context_manager, progress)
    if getattr(runner, "tool_executor", None) is not None:
        runner.tool_executor = _ObservedExecutor(runner.tool_executor, progress)
    if getattr(runner, "agent_hooks", None) is not None:
        runner.agent_hooks = _ObservedHooks(runner.agent_hooks, progress)
