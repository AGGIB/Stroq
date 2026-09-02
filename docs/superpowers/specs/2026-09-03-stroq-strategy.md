# Stroq — что строим, зачем и как (итог ресерча, 3 сентября 2026)

## Context

Исходный документ («Prompt Firewall — Market & Competitive Analysis 2026») отражает начало 2026. Проверка по первоисточникам (SEC-filings, Gartner, доки вендоров, GitHub API, arXiv; ~200 поисков и ~300 загрузок страниц тремя агентами + собственные проверки) показала, что рынок ушёл дальше:

- **Standalone prompt-firewall для чат-ботов как категория закончился.** Все pure-play куплены и стали модулями платформ: Protect AI → Palo Alto ($634.5M по 10-K), Lakera → Check Point ($201.8M по 20-F, а не «$300M»), Prompt Security → SentinelOne ($180M по 8-K, а не «$250M»), CalypsoAI → F5 ($180M), Aim → Cato, Invariant → Snyk, Pangea → CrowdStrike, Acuvity → Proofpoint (фев 2026), Enkrypt → Anaconda (авг 2026), Virtue AI → Fortinet (17.08.2026), Promptfoo → OpenAI (март 2026), Koi и Portkey → Palo Alto (апр–май 2026). Gartner в Hype Cycle AppSec 2026 **убрал категорию «AI Gateways»** и ввёл «AI Runtime Defense» и «MCP Cybersecurity».
- **Детекция промптов стоит ~0.** Google Model Armor $0.10/M токенов (2M бесплатно), OpenAI Moderation бесплатно, AWS prompt-attack $0.08/1k units, Azure $0.38/1k records, Meta Prompt Guard 2 бесплатно. Продавать «детектор за запрос» бутстрап-команде нельзя.
- **Рынок сместился к агентам и их действиям.** Gartner (26.08.2026): «securing AI» $2.835B (2026) → $4.783B (2027, +68.7%) → ~$7.7B (2028); сегменты 2027: AI application security $851M, AI usage control $749M (+73%), AI gateway $429M (+70.9%). В одну неделю сентября 2026: HiddenLayer $100M (фокус — coding-агенты), Lasso $30M, AIR $50M (проверка MCP-серверов и skills); Zenity $125M (авг 2026); Runlayer $30M (июн 2026).
- **Инциденты идут через инструменты, а не через чат.** OpenClaw (145k+★, 100k+ разработчиков подключили кредиты): ClawHavoc (335+ вредоносных skills), Moltbook (1.5M токенов), CVE-2026-25253. Snyk ToxicSkills (05.02.2026): 36.8% из 3,984 skills с дырами, 76 вредоносных, цели — OpenClaw/Claude Code/Cursor. Cursor: prompt injection → RCE CVSS 9.8 (CVE-2026-50548/9, июль 2026). Claude Code: 28 CVE за год. MCP: 40+ CVE за 4 месяца 2026, postmark-mcp бэкдор, NSA выпустило руководство (май 2026). OWASP MCP Top 10 v1.0 — октябрь 2026.
- **Защита слабая и шумная.** LivePI (июнь 2026): фронтир-агенты поддаются indirect injection в 10.7–29.6% случаев. USENIX Sec 2026: «controlled-release prompting» обходит 14 OSS guard-моделей. YARA/regex по MCP-описаниям — ~78% ложных срабатываний (AppSec Santa, апр 2026). NeMo — 16% FPR и секунды задержки. Prompt Guard 2 — 8 языков без русского, обучен на user-prompts, не на tool outputs. Только 27% CISO имеют хоть какую-то фильтрацию инъекций (NeuralTrust, июнь 2026).
- **Но LivePI показала рабочую архитектуру:** два слоя — фильтрация контента + авторизация tool-call до исполнения — перехватили 100% вредоносных целей без потери полезности. То же говорит NSA: «каждый запрос в MCP-системе должен проверяться по правилам».
- **Критичный технический факт:** у Claude Code, Cursor, Codex, Copilot и Windsurf таймаут PreToolUse-хука = **fail-open**. Любой guard, который думает дольше десятков миллисекунд или ходит в облако, молча перестаёт защищать. Это убивает cloud-API-детекторы в этой нише и даёт преимущество локальному движку.

**Вывод: делаем не «prompt firewall», а локальный «action firewall» для агентов.** Рабочее имя — Stroq (по директории).

---

## 1. Продукт (одним абзацем)

**Stroq — open-source локальный firewall для AI-агентов (Claude Code, Cursor, Codex, Copilot CLI, Windsurf, OpenClaw, любой MCP-клиент, плюс LLM-gateway'и).** Ставится одной командой, без прокси и без изменения кода — через нативные хуки агентов. Делает три вещи: (1) **сканирует всё, что агент читает** (файлы, web, MCP-ответы, вывод команд, skills) на indirect prompt injection локальной семантической моделью с низким FPR и поддержкой русского; (2) **применяет taint-aware политику к действиям**: после чтения недоверенного контента опасные действия (shell с сетью, git push на чужой remote, доступ к секретам, удаление, отправка писем, платежи) блокируются или требуют подтверждения — детерминированно, за <50 мс, на правилах стандарта ATR; (3) ведёт **tamper-evident аудит** действий агента. Платно — командный control plane: политики на парк, агрегированный аудит, алерты, SSO, экспорт в SIEM.

**Чего не делаем:** свой LLM/MCP-gateway (Obot $35M, Runlayer $42M, Docker, Kong, Cloudflare), облачный детектор за запрос (цена ~0), enterprise sales-led с первого дня, compliance-продукт (high-risk обязательства EU AI Act сдвинуты на 02.12.2027).

## 2. Позиционирование

- Слоган: **«Firewall для действий агента, а не для промптов. Локально, за 50 мс, без облака в hot path.»**
- Против кого и чем берём:
  - **Enterprise-платформы** (HiddenLayer Agent Harness, Zenity Runtime Boundaries, Noma for Cursor, Snyk Agent Guard — private preview, Endor Labs hooks, TrueFoundry hooks API, Straiker): SaaS-бэкенд в hot path, sales-led, дорого, не для SMB/индивидуалов. Мы — local-first и self-serve.
  - **Microsoft Agent Governance Toolkit** (OSS MIT, 6,180★, детерминированные политики <0.1 мс, плагин для Claude Code, консьюмит ATR): закрывает _политику_, но не семантику того, что агент читает, не taint, не multilingual. **Не конкурируем — интегрируемся**: Stroq как скорее «сенсор» рядом с AGT-политиками, ATR-совместимые правила.
  - **Соло-OSS** (Pipelock 829★ regex+receipts, GoPlus AgentGuard 458★, Falco prempti 201★, AgentWall 38★, Lasso claude-hooks, Agent Control 32★): regex/YAML, один мейнтейнер, без ML-детекции, без командного слоя, без публичных бенчмарков FPR.
  - **APort** (Free / Team $499 / Enterprise $4,990; детерминированная pre-action авторизация для Claude Code/Cursor, подписанные решения): ближайший коммерческий аналог нашей модели. Берём семантической детекцией, taint, OpenClaw/MCP-output, ценой ($299 за 10 мест) и мультиязычностью.
  - **Нативные защиты**: Claude Code auto-mode classifier (Sonnet, облачный, 0.4% FPR / 17% пропусков; серверный probe только _предупреждает_; Anthropic сама называет его «best-effort, not a security guarantee», обход опубликован 26.08.2026); Cursor — хуки есть, runtime-классификатора нет; OpenClaw — `before_tool_call`, но skills «работают с правами самого OpenClaw, без sandbox». Мы кросс-платформенны, детерминированны и кормим нативный classifier через `classifierContext`.
- Обязательные, проверяемые отличия (все — подтверждённые дыры у конкурентов):
  1. **Семантический скан tool outputs / MCP-ответов** (не только команд) с **FPR < 1%** на реальных README/MCP-описаниях — публичный бенчмарк в репо.
  2. **Taint-aware политика** (архитектура LivePI/ClawGuard): блокируем «опасное действие после недоверенного чтения», а не «подозрительный текст».
  3. **Жёсткий локальный бюджет латентности** (<50 мс p99) и **fail-closed для high-impact действий** — единственный способ не стать fail-open.
  4. **Один install → все агенты** (Claude Code, Cursor, Codex, Copilot, Windsurf — один бинарь и конфиги; OpenClaw — плагин; остальное — MCP stdio-proxy).
  5. **Русский/казахский** — у Prompt Guard 2 нет русского, у Lakera/Azure/LLM Guard публичные API text-only English-first.
  6. **Warn → block цикл настройки** с локальным журналом срабатываний (то, что просят разработчики на HN/GitHub).
- Кому продаём: команды 5–200 разработчиков с Claude Code/Cursor в проде (у Anthropic 1,000+ клиентов на $1M+/год, бизнес-подписки Claude Code ×4 с января 2026; Cursor — 50k+ enterprise-команд), операторы OpenClaw, security-команды, которым нужен аудит действий агентов. Второй канал — банки/телекомы РК под закон «Об ИИ» (в силе с 18.01.2026), где облачные детекторы неприменимы, а INFERA-подобных локальных решений в РК нет.

## 3. Рынок и проблема

- **TAM (Gartner, 26.08.2026):** $2.835B (2026) → $4.783B (2027) → ~$7.7B (2028) → $16.4B (2030). Наш сегмент — «AI usage control» ($749M в 2027) + «AI Runtime Defense» (Gartner: 5–20% adoption, пик хайпа).
- **Bottom-up:** Claude Code run-rate $2.5B+ (фев 2026, Anthropic; «$8B» — непроверенные агрегаторы); Cursor $2B+ ARR; 41% софтверных компаний с MCP в проде (Stacklok, янв 2026); безопасность — проблема №1 при внедрении MCP (50%) и блокер для 38% (Zuplo). Планово: конверсия 0.1–0.3% активных OSS-команд в Team ($299) → ~$10k MRR при ~30 командах; ~$1M ARR на горизонте 12–18 мес — реалистичная цель бутстрапа.
- **Проблема подтверждена** инцидентами (см. Context) и тем, что >20% организаций уже сообщили о взломе через AI-приложения, 92% из них не имели AI access controls (IBM, июль 2026).
- **Трезвые факты против:** ни одной проверенной независимой прибыльной prompt-security компании нет — все истории тяги закончились продажей за 12–30 месяцев (Invariant <1 год, Promptfoo ~2.5 года). Это одновременно и риск, и exit-путь: строим капитально-эффективный SaaS с permissive-ядром.

### Карта конкурентов (проверено, сентябрь 2026)

| Слой                              | Игроки                                                                                                                                                                                                                               | Что важно для нас                                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat-firewall для LLM-приложений  | Check Point (Lakera), Prisma AIRS, SentinelOne, Cisco, CrowdStrike AIDR (Pangea), Azure Prompt Shields, Bedrock Guardrails, Model Armor, Cloudflare (Enterprise add-on), Prompt Guard 2 (OSS)                                        | commodity, не основной продукт; доступны нам как guardrail-провайдеру                                                                                 |
| LLM/MCP-gateway                   | Obot, Runlayer, MintMCP, Docker MCP Gateway (interceptors), agentgateway (Solo.io), Kong, TrueFoundry, LiteLLM, Portkey (→ PANW), Bifrost                                                                                            | не строим; встраиваемся: LiteLLM Generic Guardrail API (32 вендора в доках, PR-путь), Portkey BYO webhook, Traefik external guard, Docker interceptor |
| Enterprise agent runtime security | HiddenLayer ($100M, Agent Harness 03.08.2026), Zenity ($125M, Runtime Boundaries + taint), Noma (Cursor hooks), Snyk Agent Guard (preview), Endor Labs (29 политик, SaaS), TrueFoundry hooks API, Straiker, INFERA (РФ)              | подтверждают спрос; облако в hot path, sales-led                                                                                                      |
| OSS-политика и правила            | **Microsoft AGT** (6,180★, MIT), **ATR** (683 правила, MIT; используют AGT, Cisco, MISP, SigmaHQ, FINOS), GoPlus AgentGuard (458★), Falco prempti (201★), Pipelock (829★), AgentWall (38★), Lasso claude-hooks, Agent Control, Fence | политика/regex закрыты хорошо → консьюмим ATR, дружим с AGT, дифференцируемся семантикой + taint + командным слоем                                    |
| Коммерческий self-serve           | APort ($499/$4,990), MCP Manager ($135–668), Enkrypt ($149/$1,499), Qualifire ($550), SafePrompt ($29)                                                                                                                               | коридор цен $100–1,500/мес за команду; seat-based, не токены                                                                                          |
| Скан supply chain                 | Snyk agent-scan (2,999★), Cisco Skill Scanner, Koi (→ PANW), AIR ($50M)                                                                                                                                                              | фича `stroq scan`, не продукт                                                                                                                         |
| Guard-модели                      | Prompt Guard 2 (22M/86M, 8 языков), Qualifire Sentinel v2 (0.6B, F1 0.964, 38 мс, Elastic License), Qwen3Guard (119 языков, Apache), Granite Guardian 4.1 (agentic checks, 8B), gpt-oss-safeguard (20B)                              | старт с PG2 86M + ATR; свой mDeBERTa-fine-tune с русским под Apache-2.0 — актив и канал (HF)                                                          |

## 4. Модель: open-core, seat-based

| Тир                       | Цена                               | Что входит                                                                                                  | Якорь                                            |
| ------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **OSS core** (Apache-2.0) | $0                                 | движок, адаптеры, локальная модель, taint, аудит в файл, CLI                                                | Gitleaks/Trivy-style ubiquity                    |
| **Free cloud**            | $0                                 | 1 org, 3 места, 7 дней аудита                                                                               | Langfuse Hobby                                   |
| **Team**                  | **$299/мес** (10 мест, +$20/место) | облачные/self-hosted политики на парк, 90-дневный подписанный аудит, Slack-алерты, SSO-lite                 | Semgrep/Snyk $25–30/dev, APort $499, Aikido $300 |
| **Business**              | **$1,500–2,500/мес**               | SSO/SCIM, RBAC, 1 год аудита, экспорт evidence (SOC2 CC7 / ISO 42001 A.6.2.8 / AI Act Art.12), BYOC         | TrueFoundry $2,999, Langfuse $2,499              |
| **Enterprise**            | **$25–60k/год**                    | self-hosted/air-gapped control plane, SIEM, кастомные правила, региональные требования (РК/ЕС), Marketplace | Snyk $15–40k, LiteLLM ~$30k                      |

Принципы: никогда не тарифицируем токены/запросы; гейтим то, за что enterprise уже платит везде (SSO/SCIM, retention, compliance export, self-host); дистрибуция через маркетплейсы и gateway'и, а не против них.

## 5. Архитектура MVP (максимально простая)

Монорепо на TypeScript (pnpm); Python только для offline ML. Один локальный демон, тонкие адаптеры.

```
stroq/
├── packages/
│   ├── core/            # normalizer (zero-width, гомоглифы, base64/hex/url ≤2 уровня), ATR-совместимый rules-engine,
│   │                    # taint-store, policy (deny→allow→ask), verdict с confidence и бюджетом времени
│   ├── daemon/          # Fastify на 127.0.0.1:7777, onnxruntime-node (PG2 22M/86M), SQLite hash-chained аудит,
│   │                    # warm-start, hard deadline 40 мс → детерминированный фолбэк
│   ├── cli/             # npx stroq init|status|scan|log|report|doctor|bench
│   ├── adapter-claude-code/   # HTTP-хуки (нативный type "http") + plugin manifest для marketplace
│   ├── adapter-cursor/        # .cursor/hooks.json + curl-клиент, failClosed для high-impact
│   ├── adapter-codex-copilot-windsurf/  # только конфиги под тот же curl-клиент
│   ├── adapter-openclaw/      # плагин before_tool_call (+ скан tool_result)
│   ├── mcp-proxy/             # stdio-обёртка любого MCP-сервера (Claude Desktop, Windsurf, прочие)
│   └── guard-endpoint/        # один HTTP-сервис: LiteLLM Generic Guardrail API + Portkey BYO webhook
├── ml/                  # датасет (injection + hard negatives из реальных README/MCP-описаний, RU/KZ переводы),
│                        # fine-tune mDeBERTa-v3-base → ONNX int8, eval
├── rules/               # ATR-импорт + собственные правила в формате ATR
└── bench/               # публичный eval: recall / FPR / p50,p99; CI-гейт
```

Ключевые механизмы:

- **Точки перехвата** (нативные, без прокси): Claude Code `PreToolUse` (deny/`updatedInput`), `PostToolUse` (`updatedMCPToolOutput`, `additionalContext`, `classifierContext` — наш вердикт попадает в нативный classifier), matcher `mcp__.*`; Cursor `beforeShellExecution` / `beforeMCPExecution` / `afterMCPExecution` (подмена MCP-output) / `beforeReadFile`; Codex/Copilot/Windsurf — те же JSON-контракты; OpenClaw `before_tool_call` (allow/cancel/modify); MCP stdio-proxy; LiteLLM/Portkey — webhook.
- **Детекция (3 слоя, всё локально, бюджет 40 мс):** нормализация → ATR-правила (683, MIT) → ONNX-классификатор (старт PG2 22M ~10–20 мс, 86M для спорных; фаза 2 — свой mDeBERTa с русским, Apache-2.0). Пороги: «warn» по умолчанию, «block» при высокой уверенности **и** taint. Если дедлайн истёк — только детерминированный слой, и он fail-closed для high-impact классов.
- **Policy engine:** YAML, deny → allow → ask; классы действий: `shell.network`, `shell.destructive`, `fs.secrets`, `git.push_external`, `mcp.<server>.<tool>`, `email.send`, `payment`. Решение <1 мс. Совместимость с AGT/Cedar на уровне экспорта — позже.
- **Taint:** сессия помечается при чтении недоверенного источника (web_fetch, MCP-ответ, файл вне репо, письмо, вывод команды от внешних хостов); дальше high-impact → ask/deny; фиксируем цепочки «прочитал секрет → сетевой вызов».
- **MCP:** снимок tool-descriptions при первом подключении, детект drift/rug-pull, скан описаний; `stroq scan` для skills (ClawHub/skills.sh) перед установкой.
- **Аудит:** hash-chained JSONL + SQLite; `stroq report` → HTML; в Team — подписанные решения и агрегация.
- **Fail-open для чтения, fail-closed для high-impact действий** (настраивается); демон стартует по `SessionStart`.

## 6. План работ (2–3 человека, ~8 недель до публичного релиза)

1. **Нед. 1–2 — ядро + Claude Code.** `core` (normalizer, ATR-loader, policy, taint), `daemon`, HTTP-хуки Claude Code, аудит. Демо: отравленный MCP-сервер / README с base64-инструкцией → блок `curl` наружу.
2. **Нед. 3 — детекция и бенчмарк.** ONNX PG2, датасет hard negatives (≥500 реальных README/MCP-описаний/доков), калибровка порогов, `bench/` с отчётом FPR/recall/p50/p99 в README.
3. **Нед. 4 — Cursor, Codex/Copilot/Windsurf (конфиги), OpenClaw-плагин, MCP-proxy.** `npx stroq init` автодетект.
4. **Нед. 5 — MCP drift, skills scan, `stroq report`, guard-endpoint (LiteLLM Generic API + Portkey webhook).**
5. **Нед. 6 — запуск.** README с бенчмарком; Claude Code community marketplace; Cursor Marketplace; ClawHub; PR в доки LiteLLM (страница провайдера); Homebrew/npm; Show HN + Habr (RU) + 1 responsible-disclosure по отравленному MCP/skill (канал, который сработал у Aim/Noma/Pillar/Koi). Метрика: 1k★ и 100 активных установок за 30 дней.
6. **Нед. 7–8 — Team control plane (минимум).** Политики из репо/облака, агрегированный аудит, Slack-алерты, Stripe, pricing page. Цель: 5 платящих команд из ранних пользователей.

Параллельно (дёшево): заявка в SecureIQLab (независимая методика тестов AI Firewall, с апреля 2026); публикация мультиязычной модели на HF; фаза 2 — self-hosted control plane + on-prem gateway-режим для банков РК.

## 7. Риски и как снимаем

- **Вендоры агентов встроят это нативно** (Claude Code auto mode — дефолт с 14.08.2026; PANW в Codex). Ответ: кросс-платформенность, детерминизм и локальность (их classifier облачный, нон-детерминированный, только свой агент), taint и аудит по парку; интеграция через `classifierContext`, а не война.
- **Microsoft AGT / ATR съедят «политику».** Не конкурируем: консьюмим ATR, экспортируем в AGT; наша ценность — семантика того, что агент читает, taint, multilingual, командный слой.
- **APort/HiddenLayer/Zenity опередят в control plane.** Берём ценой ($299 vs $499), OSS-ядром, OpenClaw и MCP-output, бенчмарком FPR.
- **Ложные срабатывания убьют adoption.** Дефолт «warn», блок только при taint + уверенности; hard negatives в CI-гейте; локальный журнал и `/feedback`-цикл.
- **Латентность → fail-open.** Жёсткий дедлайн 40 мс, прогретый демон, ONNX int8, детерминированный фолбэк.
- **Лицензии моделей.** PG2 — Llama 4 Community (ок до 700M MAU, атрибуция); Sentinel v2 — Elastic (не используем в ядре); свой fine-tune под Apache-2.0 — приоритет фазы 2.
- **Скоуп.** MVP = Claude Code + один сценарий (отравленный контент → блок опасного действия). Остальное после первых установок.

## 8. Верификация

- Unit: normalizer (9 кодировок, вложенность 2), policy (порядок deny/allow/ask, wildcard, классы действий), taint (цепочки), ATR-loader (все 683 правила парсятся).
- ML eval (`bench/`): recall на injection-кейсах (AgentDojo-подмножество + LivePI-подобные сценарии + ToxicSkills-паттерны), FPR на ≥500 реальных README/MCP-описаний, p50/p99 на CPU. Порог релиза: recall ≥90% direct, ≥70% indirect, FPR ≤1%, p99 ≤40 мс.
- E2E: фикстуры хуков Claude Code (JSON stdin → JSON-решение) и HTTP-хуков; Cursor hooks.json; OpenClaw-плагин в тестовом инстансе; MCP-proxy с намеренно отравленным сервером: (a) описание инструмента с инструкцией на эксфильтрацию → блок; (b) README с base64-инструкцией → warn, затем `curl` на внешний хост → deny; (c) drift описания после первого подключения → алерт; (d) таймаут детектора → high-impact действие всё равно блокируется детерминированным слоем.
- Ручная проверка: `npx stroq init` на чистой машине (macOS/Linux) <2 минут до первого блока; `stroq report` показывает цепочку.

## 9. Допущения (если не так — скажите)

- Целевой рынок — глобальный developer-first (англ.), РК/СНГ — второй канал. Если приоритет — банки РК on-prem, порядок меняется: сначала self-hosted gateway-режим и мультиязычная модель, продажи sales-led.
- Стек — TypeScript (экосистема хуков/плагинов, OpenClaw-плагины на TS, ваши web-правила); ML offline на Python. Альтернатива для дистрибуции одним бинарём — Go, если npx окажется барьером.
- Команда 2–3 человека без выделенного ML-инженера: стартуем с готовых моделей и правил ATR, свой fine-tune — фаза 2.

## 10. Ключевые источники

Gartner PR 26.08.2026 (перепечатки ARN/SecurityBrief) · Gartner Hype Cycle AppSec 2026 (NeuralTrust/F5) · PANW 10-K FY2025 R72 · Check Point 20-F FY2025 R52 · SentinelOne 8-K 08.09.2025 · TechCrunch HiddenLayer $100M 02.09.2026 · SiliconANGLE Lasso 02.09.2026 · Zenity $125M 04.08.2026 · Fortinet–Virtue AI 17.08.2026 · Snyk ToxicSkills 05.02.2026 · Adversa OpenClaw guide · Practical DevSecOps MCP stats 2026 · NSA CSI MCP 20.05.2026 · OX Security MCP supply chain 15.04.2026 · Cato CVE-2026-50548/9 · Phoenix Claude Code CVEs · LivePI arXiv 2605.17986 · ClawGuard arXiv 2604.11790 · USENIX Sec 2026 arXiv 2510.01529 · AppSec Santa MCP audit 04.2026 · Anthropic auto-mode engineering 25.03.2026 и docs/hooks · Cursor docs/hooks · Codex hooks docs · Copilot hooks reference · LiteLLM generic guardrail API · Portkey BYO guardrails · Microsoft AGT repo · ATR repo/spec · Pipelock, AgentGuard, prempti, AgentWall, APort pricing · AWS/Azure/Google/Cloudflare pricing pages · Semgrep/Snyk/Langfuse/TrueFoundry pricing · Morgan Lewis EU AI Act Omnibus 06.2026 · EY/Forbes.kz о законе РК «Об ИИ».
