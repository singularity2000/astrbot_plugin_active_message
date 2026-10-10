from __future__ import annotations

import asyncio
import copy
import json
import math
import re
import time
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit

from .config import DecisionConfig
from .models import DecisionResult
from .prompts import render_system_template, render_template, validate_template
from .text_context import dumps, drop_oldest, estimate_tokens, over_budget, text_only


class DecisionError(Exception):
    """Safe, structured failure metadata; never raw provider exception text."""

    def __init__(self, message: str, *, details=None, retryable=False, retry_after=None):
        super().__init__(message)
        self.code = message.split(":", 1)[0]
        self.details = details or {}
        self.retryable = retryable
        self.retry_after = retry_after


def validate_score(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise DecisionError("MODEL_INVALID: score must be a number")
    score = float(value)
    if not math.isfinite(score) or score < 0 or score > 1:
        raise DecisionError("MODEL_INVALID: score must be finite and within 0..1")
    return score


def parse_llm_score(text: str) -> tuple[float, str]:
    stripped = text.strip()
    if stripped.startswith("```"):
        match = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", stripped, flags=re.DOTALL)
        if not match:
            raise DecisionError("MODEL_INVALID: invalid code block")
        stripped = match.group(1)
    try:
        payload = json.loads(stripped)
    except (ValueError, TypeError):
        raise DecisionError("MODEL_INVALID: response must be JSON") from None
    if isinstance(payload, dict):
        score = validate_score(payload.get("score"))
        reason = payload.get("reason", "")
        return score, reason if isinstance(reason, str) else ""
    return validate_score(payload), ""


def validate_jev_endpoint(endpoint: str) -> str:
    """Accept explicitly configured relays; never forward credentials on redirects."""
    import ipaddress
    try:
        parsed = urlsplit(endpoint)
        host = parsed.hostname
        local = host == "localhost"
        if host and not local:
            try:
                local = ipaddress.ip_address(host).is_loopback
            except ValueError:
                pass
        if not host or parsed.scheme not in {"https", "http"} or (parsed.scheme == "http" and not local):
            raise ValueError
        if parsed.username or parsed.password or parsed.query or parsed.fragment or not parsed.path:
            raise ValueError
        _ = parsed.port
        if any(c.isspace() for c in endpoint):
            raise ValueError
    except ValueError:
        raise DecisionError("JEV_CONFIG: use a complete HTTPS endpoint (HTTP only on loopback); no URL credentials, query, or fragment") from None
    return endpoint


def prepare_request(config: DecisionConfig, values: dict) -> tuple[str, str, dict]:
    """Fit the final rendered request, including repeated custom placeholders."""
    validate_template(config.prompt, decision=True)
    validate_template(config.jev_state_template, decision=True)
    values = copy.deepcopy(values)
    payload = values.get("_context_payload", {})
    removed = 0
    while True:
        values["conversation_history"] = dumps(payload.get("conversation_history", []))
        values["recent_messages"] = dumps(payload.get("recent_group_messages", []))
        values["image_descriptions"] = dumps(payload.get("image_descriptions", []))
        instructions, references = render_system_template(config.prompt, values)
        instructions = text_only(instructions)
        if config.mode == "llm":
            instructions += '\n仅输出 JSON 对象：{"score": 0 到 1 的数字, "reason": "简短理由"}。不要使用工具，不生成聊天回复。'
        state = dumps({"supplement": text_only(render_template(config.jev_state_template, values)),
                       "template_references": references, "current_message": values.get("current_message", ""),
                       "context": payload})
        combined = instructions + "\n" + state
        metrics = {"input_chars": len(combined), "input_bytes": len(combined.encode("utf-8")),
                   "estimated_tokens": estimate_tokens(combined), "max_chars": config.max_input_chars,
                   "max_tokens": config.max_input_tokens, "budget_removed_records": removed,
                   "token_count_kind": "conservative_estimate"}
        if not over_budget(combined, config.max_input_chars, config.max_input_tokens):
            return instructions, state, metrics
        if not drop_oldest(payload):
            raise DecisionError("INPUT_TOO_LARGE: fixed instructions exceed input budget", details=metrics)
        removed += 1


class DecisionClient:
    def __init__(self, context: object, capture=None, report=None) -> None:
        self.context = context
        self.capture = capture or (lambda *args: None)
        self.report = report or (lambda *args, **kwargs: None)
        self._http = None

    async def close(self) -> None:
        if self._http is not None:
            await self._http.close()
            self._http = None

    async def decide(self, config: DecisionConfig, values: dict) -> DecisionResult:
        started = time.monotonic()
        instructions, state, metrics = prepare_request(config, values)
        run_id, sid = values.get("_run_id"), values.get("sid", "")
        self.report(run_id, "JUDGMENT_INPUT", sid=sid, **metrics)
        attempts = 0
        try:
            async with asyncio.timeout(config.timeout_seconds):
                for attempt in range(config.retry_attempts + 1):
                    attempts = attempt + 1
                    try:
                        if config.mode == "llm":
                            score, reason, model = await self._llm(config, instructions, state, run_id)
                        elif config.mode == "jev":
                            score, model = await self._jev(config, instructions, state, run_id=run_id)
                            reason = "未提供"
                        else:
                            raise DecisionError("MODE_INVALID: choose llm or jev")
                        break
                    except DecisionError as exc:
                        if not exc.retryable or attempt >= config.retry_attempts:
                            exc.details.update(attempts=attempts, **metrics)
                            raise
                        delay = exc.retry_after if exc.retry_after is not None else config.retry_delay_seconds * (2 ** attempt)
                        self.report(run_id, "MODEL_RETRY", sid=sid, attempt=attempts, delay_seconds=delay, **exc.details)
                        await asyncio.sleep(delay)
        except TimeoutError:
            raise DecisionError("MODEL_TIMEOUT: judgment request timed out", details={**metrics, "attempts": attempts,
                                "elapsed_ms": round((time.monotonic() - started) * 1000, 1)}) from None
        return DecisionResult(score, reason, config.mode, str(model), (time.monotonic() - started) * 1000)

    async def _llm(self, config, instructions, state, run_id):
        if not config.provider_id:
            raise DecisionError("PROVIDER_MISSING: select a judgment provider")
        provider = self.context.get_provider_by_id(config.provider_id)
        if provider is None or not callable(getattr(provider, "text_chat", None)):
            raise DecisionError("PROVIDER_MISSING: judgment provider is unavailable")
        self.capture(run_id, "LLM 调用文字快照（非最终网络报文）", {
            "provider_id": config.provider_id, "system_prompt": instructions, "prompt": state, "contexts": [], "func_tool": None})
        try:
            response = await provider.text_chat(prompt=state, system_prompt=instructions, contexts=[], func_tool=None)
        except TimeoutError:
            raise
        except Exception as exc:
            status = getattr(exc, "status_code", None)
            details = {"exception_type": type(exc).__name__}
            if isinstance(status, int):
                details["http_status"] = status
            retryable = status in {429, 500, 502, 503, 504, 529} or isinstance(exc, ConnectionError)
            raise DecisionError("MODEL_ERROR: provider request failed", details=details, retryable=retryable) from None
        if getattr(response, "role", "assistant") != "assistant":
            raise DecisionError("MODEL_INVALID: provider did not return an assistant response")
        text = getattr(response, "completion_text", None)
        self.capture(run_id, "判断模型文字响应", text)
        if not isinstance(text, str):
            raise DecisionError("MODEL_INVALID: response is not text")
        score, reason = parse_llm_score(text)
        model = provider.get_model() if callable(getattr(provider, "get_model", None)) else config.provider_id
        return score, reason, model

    async def _jev(self, config: DecisionConfig, instructions: str, state: str, *, run_id=None) -> tuple[float, str]:
        import aiohttp

        endpoint = validate_jev_endpoint(config.jev_endpoint)
        if not config.jev_api_key or "\n" in config.jev_api_key or "\r" in config.jev_api_key:
            raise DecisionError("JEV_CONFIG: provide a valid API key")
        if self._http is None or self._http.closed:
            self._http = aiohttp.ClientSession()
        body = {"model": config.jev_model, "state": state,
                "questions": {"should_speak": {"type": "noul", "instructions": instructions}}}
        self.capture(run_id, "Jev HTTP 文字请求快照（无鉴权头）", {"endpoint": endpoint, "body": body})
        try:
            async with self._http.post(endpoint, headers={"Authorization": f"Bearer {config.jev_api_key}"},
                                       json=body, timeout=aiohttp.ClientTimeout(total=config.timeout_seconds),
                                       allow_redirects=False) as response:
                if response.status != 200:
                    details = {"http_status": response.status}
                    # Read only a bounded error prefix; never expose arbitrary returned text.
                    raw_error = await response.content.read(4096)
                    try:
                        error = json.loads(raw_error)
                        code = error.get("detail") if isinstance(error, dict) else None
                        if code in {"upstream_error", "rate_limit_exceeded", "context_length_exceeded",
                                    "invalid_api_key", "insufficient_quota", "invalid_request_error", "overloaded", "server_error"}:
                            details["upstream_code"] = code
                    except (ValueError, TypeError):
                        pass
                    retry_after = None
                    try:
                        number = float(response.headers.get("Retry-After", ""))
                        if math.isfinite(number) and number >= 0:
                            retry_after = number
                    except (ValueError, TypeError):
                        try:
                            retry_at = parsedate_to_datetime(response.headers.get("Retry-After", ""))
                            retry_after = max(0.0, retry_at.timestamp() - time.time())
                        except (ValueError, TypeError, OverflowError):
                            pass
                    raise DecisionError("JEV_HTTP: request rejected", details=details,
                                        retryable=response.status in {429, 500, 502, 503, 504, 529}, retry_after=retry_after)
                chunks, total = [], 0
                async for chunk in response.content.iter_chunked(8192):
                    total += len(chunk)
                    if total > 1024 * 1024:
                        raise DecisionError("MODEL_INVALID: response exceeds 1 MiB")
                    chunks.append(chunk)
                try:
                    payload = json.loads(b"".join(chunks))
                    self.capture(run_id, "Jev JSON 响应", payload)
                    answer = payload["answers"]["should_speak"]
                    if answer.get("type", "noul") != "noul":
                        raise ValueError
                    score = validate_score(answer["noul"])
                except DecisionError:
                    raise
                except (ValueError, KeyError, TypeError, AttributeError):
                    raise DecisionError("MODEL_INVALID: invalid TypeSafe Noul response") from None
                return score, str(payload.get("model", config.jev_model))
        except aiohttp.ClientError as exc:
            raise DecisionError("MODEL_ERROR: Jev transport failed", details={"exception_type": type(exc).__name__},
                                retryable=isinstance(exc, aiohttp.ClientConnectionError)) from None
