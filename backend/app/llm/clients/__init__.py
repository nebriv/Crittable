"""Concrete ``ChatClient`` implementations.

* ``litellm_client.LiteLLMChatClient`` — routes via LiteLLM (~100 providers).

The Anthropic-direct implementation lives at ``app.llm.client.LLMClient`` for
historical reasons; it pre-dates this package. Both satisfy
``app.llm.protocol.ChatClient``.
"""
