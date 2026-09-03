## Security model

Prompt injection is a risk for any LLM app. Never store secrets in the repository; keep API keys in
environment variables. The system prompt is configured in `prompts/system.txt`. If you find a
vulnerability, do not disclose it publicly; email security@example.com. Rotate credentials quarterly.
