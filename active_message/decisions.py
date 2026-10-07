from __future__ import annotations

import asyncio
import json
import math
import re
import time
from urllib.parse import urlsplit

from .config import DecisionConfig
from .models import DecisionResult
from .prompts import render_system_template, render_template, validate_template


class DecisionError(Exception):
    """只携带安全的错误分类，不包含凭据、Provider 返回正文或聊天原文。"""


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


class DecisionClient:
    def __init__(self, context: object, capture=None) -> None:
        self.context = context
        self.capture = capture or (lambda *args: None)
        self._http = None

    async def close(self) -> None:
        if self._http is not None:
            await self._http.close()
            self._http = None

    async def decide(self, config: DecisionConfig, values: dict) -> DecisionResult:
        started = time.monotonic()
        validate_template(config.prompt, decision=True)
        validate_template(config.jev_state_template, decision=True)
        instructions, references = render_system_template(config.prompt, values)
        state = json.dumps({"supplement": render_template(config.jev_state_template, values),
                            "template_references": references,
                            "current_message": values.get("current_message", ""),
                            "context": values.get("_context_payload", {})}, ensure_ascii=False)
        run_id = values.get("_run_id")
        try:
            async with asyncio.timeout(config.timeout_seconds):
                if config.mode == "llm":
                    if not config.provider_id:
                        raise DecisionError("PROVIDER_MISSING: select a dedicated judgment provider")
                    provider = self.context.get_provider_by_id(config.provider_id)
                    if provider is None or not callable(getattr(provider, "text_chat", None)):
                        raise DecisionError("PROVIDER_MISSING: judgment provider is unavailable")
                    system_prompt = instructions + '\n仅输出 JSON 对象：{"score": 0 到 1 的数字, "reason": "简短理由"}。不要使用工具，不生成聊天回复。'
                    self.capture(run_id, "LLM 调用参数（Provider 可能继续处理；无凭据）", {
                        "provider_id":config.provider_id, "system_prompt":system_prompt, "prompt":state, "contexts":[], "func_tool":None})
                    response = await provider.text_chat(
                        prompt=state,
                        system_prompt=system_prompt,
                        contexts=[],
                        func_tool=None,
                    )
                    if getattr(response, "role", "assistant") != "assistant":
                        raise DecisionError("MODEL_INVALID: provider did not return an assistant response")
                    self.capture(run_id, "判断模型原始文本响应", response.completion_text)
                    score, reason = parse_llm_score(response.completion_text)
                    model = provider.get_model() if callable(getattr(provider, "get_model", None)) else config.provider_id
                elif config.mode == "jev":
                    score, model = await self._jev(config, instructions, state, run_id=run_id)
                    reason = "未提供"
                else:
                    raise DecisionError("MODE_INVALID: choose llm or jev")
        except TimeoutError:
            raise DecisionError("MODEL_TIMEOUT: judgment request timed out") from None
        except DecisionError:
            raise
        except Exception as exc:
            raise DecisionError(f"MODEL_ERROR: {type(exc).__name__}") from None
        return DecisionResult(score, reason, config.mode, str(model), (time.monotonic() - started) * 1000)

    async def _jev(self, config: DecisionConfig, instructions: str, state: str, *, run_id=None) -> tuple[float, str]:
        import aiohttp

        endpoint = validate_jev_endpoint(config.jev_endpoint)
        if not config.jev_api_key or "\n" in config.jev_api_key or "\r" in config.jev_api_key:
            raise DecisionError("JEV_CONFIG: provide a valid API key")
        if self._http is None or self._http.closed:
            self._http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=config.timeout_seconds))
        body = {"model":config.jev_model, "state":state,
                "questions":{"should_speak":{"type":"noul", "instructions":instructions}}}
        self.capture(run_id, "Jev HTTP 请求体（无鉴权头）", {"endpoint":endpoint, "body":body})
        async with self._http.post(
            endpoint,
            headers={"Authorization": f"Bearer {config.jev_api_key}"},
            json=body,
            timeout=aiohttp.ClientTimeout(total=config.timeout_seconds),
            allow_redirects=False,
        ) as response:
            if response.status != 200:
                raise DecisionError(f"JEV_HTTP: status={response.status}")
            chunks = []
            total = 0
            async for chunk in response.content.iter_chunked(8192):
                total += len(chunk)
                if total > 1024 * 1024:
                    raise DecisionError("MODEL_INVALID: response exceeds 1 MiB")
                chunks.append(chunk)
            raw = b"".join(chunks)
            try:
                payload = json.loads(raw)
                self.capture(run_id, "Jev 原始 JSON 响应", payload)
                answer = payload["answers"]["should_speak"]
                if answer.get("type", "noul") != "noul":
                    raise ValueError
                score = validate_score(answer["noul"])
            except DecisionError:
                raise
            except (ValueError, KeyError, TypeError, AttributeError):
                raise DecisionError("MODEL_INVALID: invalid TypeSafe Noul response") from None
            return score, str(payload.get("model", config.jev_model))
