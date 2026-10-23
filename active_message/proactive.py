"""原生未来任务 Agent 的主动聊天适配、执行跟踪与取消清理。"""
from __future__ import annotations

from .i18n import catalog

import json
import asyncio
import time
from typing import Any
from .native import session_allows_plugin
from .prompts import render_template
from .diagnostics import exception_details


async def run_proactive_agent(plugin: Any, sid: str, meta: dict[str, Any]) -> None:
    # Follow CronJobManager._woke_main_agent for request construction, tools,
    # execution and persistence. Keep scheduling/diagnostics local to this run.
    from astrbot.core.agent.tool import ToolSet
    from astrbot.core.astr_main_agent import MainAgentBuildConfig, _get_session_conv, build_main_agent
    from astrbot.core.astr_main_agent_resources import (
        PROACTIVE_AGENT_CRON_WOKE_SYSTEM_PROMPT, PROACTIVE_AGENT_CRON_WOKE_USER_PROMPT,
    )
    from astrbot.core.config.agent_runner import resolve_context_compression_config
    from astrbot.core.cron.events import CronMessageEvent
    from astrbot.core.platform.message_session import MessageSession
    from astrbot.core.provider.entities import ProviderRequest
    from astrbot.core.star.session_llm_manager import SessionServiceManager
    from astrbot.core.tools.message_tools import SendMessageToUserTool
    from astrbot.core.utils.config_number import coerce_int_config
    from astrbot.core.utils.history_saver import persist_agent_history
    from astrbot.core.utils.session_lock import session_lock_manager

    config = plugin._config_for(sid)
    progress: RunProgress = meta["progress"]
    context = plugin.context
    session = MessageSession.from_str(sid)
    event = CronMessageEvent(
        context=context, session=session, message="",
        extras={"_active_message_meta": meta}, message_type=session.message_type,
    )
    event.role = "member"
    cfg = context.get_config(umo=sid)
    selected = cfg.get("plugin_set", ["*"])
    event.plugins_name = None if selected == ["*"] else selected
    runner = None
    progress.enter("session_lock")
    async with session_lock_manager.acquire_lock(sid):
        progress.enter("checks")
        if meta.get("scheduled_date", plugin._now(sid).date().isoformat()) != plugin._now(sid).date().isoformat():
            progress.result = "skipped"
            progress.outcome = "跳过：这次预约属于前一天"
            return
        if not plugin.proactive_allowed_now(sid) or not session_allows_plugin(context, sid, plugin.PLUGIN_ID):
            progress.result = "skipped"
            progress.outcome = "跳过：运行条件已变化"
            plugin.observer.log("debug", "PROACTIVE_SKIPPED", sid=sid, run_id=meta["run_id"])
            return
        if not await SessionServiceManager.should_process_llm_request(event):
            progress.result = "skipped"
            progress.outcome = "跳过：会话 LLM 已关闭"
            plugin.observer.log("info", "SESSION_LLM_DISABLED", sid=sid, run_id=meta["run_id"])
            return
        cfg = context.get_config(umo=sid)
        if cfg.get("agent_runner", {}).get("runner_type", "local") != "local":
            progress.result = "skipped"
            progress.outcome = "跳过：不支持的 Agent 类型"
            plugin.observer.log("warning", "PROACTIVE_RUNNER_UNSUPPORTED", sid=sid, run_id=meta["run_id"])
            return
        settings = cfg.get("provider_settings", {}) or {}
        runner_settings = cfg.get("agent_runner", {}).get("config", {})
        persona_settings = runner_settings.get("persona", {})
        misc = runner_settings.get("misc", {})
        model = runner_settings.get("model", {})
        build_cfg = MainAgentBuildConfig(
            tool_call_timeout=misc.get("tool_call_timeout", 120),
            fallback_provider_ids=model.get("fallback_provider_ids", []),
            **resolve_context_compression_config(runner_settings.get("compression", {})),
            llm_safety_mode=persona_settings.get("safety_mode", True),
            safety_mode_strategy=persona_settings.get("safety_mode_strategy", "system_prompt"),
            streaming_response=False,
            computer_use_runtime=settings.get("computer_use_runtime", "none"),
            sandbox_cfg=settings.get("sandbox", {}),
            provider_settings=settings,
        )
        max_steps = coerce_int_config(misc.get("max_steps", 128), default=128, min_value=1,
                                     field_name="agent_runner.config.misc.max_steps")
        progress.enter("conversation")
        conversation = await _get_session_conv(event, context)
        progress.enter("context")
        values = await plugin._values(event, conversation, "主动聊天")
        values.update(model_score="不适用", score="不适用", decision_reason="定时主动聊天")
        description = "\n\n".join(text for text in (
            render_template(config.proactive_task_prompt, values),
            render_template(meta["activation_template"], values),
        ) if text)
        cron_meta = {
            "id": meta["run_id"], "name": "主动聊天", "type": "active_agent", "run_once": True,
            "description": description, "note": description,
            "run_started_at": plugin._now(sid).isoformat(), "run_at": meta.get("scheduled_at"),
            "session": sid,
        }
        event = CronMessageEvent(
            context=context, session=session, message=description,
            extras={"_active_message_meta": meta, "cron_job": cron_meta,
                    "cron_payload": {"session": sid, "note": description}}, message_type=session.message_type,
        )
        event.role = "member"
        event.plugins_name = None if selected == ["*"] else selected
        request = ProviderRequest(
            conversation=conversation, contexts=json.loads(conversation.history or "[]"),
            system_prompt=PROACTIVE_AGENT_CRON_WOKE_SYSTEM_PROMPT,
            prompt=PROACTIVE_AGENT_CRON_WOKE_USER_PROMPT.format(cron_job=json.dumps(cron_meta, ensure_ascii=False)),
        )
        request.func_tool = ToolSet()
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
            # Native future tasks go straight from build to the runner. Do not
            # add request hooks, duplicate history or replace the native sender.
            plugin._capture(meta["run_id"], "原生未来任务请求（非最终网络报文）", {
                "system_prompt": result.provider_request.system_prompt,
                "prompt": result.provider_request.prompt,
                "contexts": result.provider_request.contexts,
                "tools": [tool.name for tool in result.provider_request.func_tool.tools]
                         if result.provider_request.func_tool else [],
            })
            if reset is not None:
                progress.enter("reset")
                await reset
                reset = None
            observe_runner(runner, progress)
            plugin.runtime.get(sid).agent_active = True
            plugin.observer.log("debug", "AGENT_STARTED", sid=sid, run_id=meta["run_id"], role="member", trigger_type="主动聊天")
            progress.enter("agent")
            async for _ in runner.step_until_done(max_steps):
                pass
            response = runner.get_final_llm_resp()
            if getattr(getattr(runner, "state", None), "name", "") == "ERROR":
                raise NativeAgentError("NATIVE_AGENT_ERROR")
            if getattr(getattr(runner, "state", None), "name", "") != "DONE":
                raise NativeAgentError("NATIVE_AGENT_NOT_COMPLETED")
            summary = (f"[CronJob] {cron_meta['name']}: {cron_meta['description']} "
                       f" triggered at {cron_meta['run_started_at']}, ")
            if response and response.role == "assistant":
                summary += f"I finished this job, here is the result: {response.completion_text}"
            progress.enter("history")
            await persist_agent_history(context.conversation_manager, event=event, req=result.provider_request, summary_note=summary)
            plugin.traces.add(meta["run_id"], "主动任务历史已交由原生接口保存", {"conversation_id":getattr(conversation,"cid",None)})
            progress.sent = progress.sent or event.get_extra("_active_message_sent", False)
            if not progress.sent:
                plugin.observer.log("debug", "PROACTIVE_NO_SEND", sid=sid, run_id=meta["run_id"])
            progress.outcome = "已发送，任务完成" if progress.sent else "正常完成，未发送"
            progress.enter("complete")
            progress.completed = True
            progress.result = "completed"
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
                    remaining = {task for task in progress.active_tools if not task.done()}
                    if remaining:
                        plugin._valid = False
                        plugin._unfinished_tools.update(remaining)
                        def forget(task):
                            plugin._unfinished_tools.discard(task)
                            if not task.cancelled():
                                task.exception()
                        for task in remaining:
                            task.add_done_callback(forget)
                    plugin.runtime.get(sid).agent_active = False


PHASES = catalog()["phases"]


class NativeAgentError(RuntimeError):
    """原生 Agent 返回失败或未确认完成；不能当作正常完成来消耗额度。"""


class RunProgress:
    def __init__(self, observer: Any, sid: str, run_id: str, timeout: float | None, *, capture=None) -> None:
        self.observer, self.sid, self.run_id = observer, sid, run_id
        self.capture = capture
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
        self.result = "failed"
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
                "sent": self.sent, "result": self.result, **self.details,
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
        if p.capture is not None:
            p.capture(p.run_id, "第 " + str(p.calls) + " 次模型调用", {
                "response": {"role": role, "text": getattr(response, "completion_text", ""),
                             "reasoning": getattr(response, "reasoning_content", None),
                             "tool_names": getattr(response, "tools_call_name", []) or [],
                             "tool_arguments": getattr(response, "tools_call_args", []) or []},
            }, key="llm:" + str(p.calls), tone="warning" if role == "err" else "response")
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
        try:
            await getattr(self.original, name)(*args)
        except Exception as exc:
            self.progress.failure("PROACTIVE_HOOK_FAILED", exc, hook=name)
            raise
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
