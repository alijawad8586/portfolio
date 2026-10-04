# Autonomous Content Engine — Architecture (Module 0)

Status: **plan only**. No application code exists yet. Modules 1–12 implement this plan in order.

## 1. Goals and non-negotiable rules

Pipeline: Research → Pattern → Content → Organization → **Human Approval** → Publishing → Analytics → Feedback.

| # | Rule | How the architecture enforces it |
|---|------|----------------------------------|
| 1 | Modular, no giant files | One package per concern (see §3) |
| 2 | One responsibility per agent | Each agent = 1 service + 1 LangGraph node + 1 Pydantic input/output pair |
| 3 | Agents talk via structured data | Pydantic schemas in `schemas/`; agents never pass free text to each other |
| 4 | No auto-publish | Publishing code path requires `status == APPROVED` **and** an `approval_requests` row; checked in 3 places (§8) |
| 5 | AI logic ≠ API routes | `api/` calls `services/`; `services/` calls `agents/`; routes never import an LLM client |
| 6 | DB logic ≠ agent logic | Agents receive/return schemas; only `repositories/` touches SQL |
| 7 | Secrets via env | `core/config.py` (pydantic-settings); platform tokens encrypted at rest (§5) |
| 8 | Logging + error handling | Structured JSON logs, request IDs, typed exception hierarchy, `agent_runs` + `audit_logs` tables |
| 9 | More platforms later | `PlatformAdapter` interface + registry; adding a platform = 1 new file + 1 registry line |

## 2. High-level diagram

```
Next.js (Supabase Auth session) ──JWT──► FastAPI
                                           │
                    api/ (routes, deps, validation only)
                                           │
                    services/ (business rules, workflow glue)
                       │            │                 │
                 agents/ (LangGraph) │         publishing/ + tools/
                       │            │                 │
                 repositories/ ◄────┘          platforms/ adapters
                       │                               │
                 PostgreSQL (Supabase, RLS)     LinkedIn / Meta APIs
```

Dependency direction is one-way: `api → services → (agents | repositories | tools)`. Agents never import repositories or platforms. Tools never import agents.

## 3. Folder structure

```
content-engine/
├── docs/                         ARCHITECTURE.md, ADRs
├── supabase/
│   ├── config.toml
│   ├── migrations/               timestamped SQL (Module 1)
│   └── seed.sql                  demo data
├── backend/
│   ├── pyproject.toml
│   ├── .env.example
│   ├── app/
│   │   ├── main.py               FastAPI app factory, middleware, router mount
│   │   ├── core/                 config, logging, security (JWT verify, crypto), errors, constants
│   │   ├── db/                   engine/session, base model, health check
│   │   ├── models/               SQLAlchemy models (1 file per table group)
│   │   ├── schemas/              Pydantic: research, angle, draft, calendar, approval, publishing, analytics, agent_state
│   │   ├── repositories/         SQL only; one repo per aggregate; always workspace-scoped
│   │   ├── services/             research_service, pattern_service, content_service,
│   │   │                         organization_service, approval_service, publishing_service,
│   │   │                         analytics_service, workflow_service
│   │   ├── agents/
│   │   │   ├── base.py           BaseAgent: run(), timing, agent_runs logging, retries
│   │   │   ├── research/         node.py, prompts.py, chain.py
│   │   │   ├── pattern/          node.py, prompts.py, diagnostic.py (angle quality rules)
│   │   │   ├── content/          node.py, prompts/{linkedin,instagram,facebook}.py
│   │   │   ├── organization/     node.py, scheduler.py, duplicates.py, conflicts.py
│   │   │   └── feedback/         node.py, pattern_learning.py
│   │   ├── graph/                state.py, builder.py, checkpointer.py, gates.py (approval interrupt)
│   │   ├── tools/                Social tool layer (MCP-style): interface.py, registry.py, mock mode
│   │   ├── platforms/            base.py (PlatformAdapter), linkedin.py, facebook.py, instagram.py, errors.py
│   │   ├── publishing/           queue.py, validator.py, worker.py, idempotency.py, retry.py
│   │   ├── api/
│   │   │   ├── deps.py           get_current_user, get_workspace_ctx, require_role
│   │   │   └── v1/               auth, workspaces, accounts, campaigns, research, angles, drafts,
│   │   │                         calendar, approvals, publishing, analytics, dashboard, runs
│   │   └── workers/              scheduler loop (APScheduler) for publish + metrics polling
│   └── tests/                    unit/, integration/, api/, e2e/
└── frontend/
    ├── package.json  tailwind.config.ts  tsconfig.json  .env.example
    └── src/
        ├── app/                  App Router: (auth)/login, (app)/dashboard, campaigns/new (wizard),
        │                         research, angles, studio, calendar, approvals, publishing, analytics
        ├── components/           ui/ (primitives), pipeline/, approval/, calendar/, charts/
        ├── features/             one folder per module: api hooks + components + types
        ├── lib/                  supabase client, api client (attaches JWT), zod schemas
        └── middleware.ts         redirects unauthenticated users
```

## 4. Backend modules (and why each exists)

| Module | Responsibility | Why separate |
|--------|----------------|--------------|
| `core` | Config, logging, errors, crypto | One place for cross-cutting concerns |
| `models` / `repositories` | Tables and SQL | Swap DB or test with fakes without touching agents |
| `schemas` | The contract between agents, API, UI | Structured data between agents (rule 3) |
| `agents/*` | LLM reasoning, one job each | Independently testable, replaceable prompts |
| `graph` | LangGraph state, checkpoints, approval interrupt | Orchestration separate from agent logic |
| `services` | Business rules, transactions, persistence of agent output | The only layer that wires agents + repos |
| `tools` | Abstract `create_post`, `schedule_post`, … | Agents never see platform APIs (Module 7) |
| `platforms` | LinkedIn/Meta specifics, rate limits, token errors | New platform = new adapter |
| `publishing` | Queue, validation, idempotency, retry | The only code allowed to call `tools` write methods |
| `api` | HTTP, auth, validation, response mapping | Thin; no business logic |

## 5. Database tables (Module 1)

All tables: `id uuid pk default gen_random_uuid()`, `created_at`, `updated_at` (trigger), and a `workspace_id` FK on every tenant table. Status columns use Postgres enums (or CHECK constraints) so values are controlled.

| Table | Key columns | Notes |
|-------|-------------|-------|
| `users` | id (= `auth.users.id`), email, full_name | Profile mirror of Supabase Auth |
| `workspaces` | name, owner_id | Tenant boundary |
| `workspace_members` | workspace_id, user_id, role (owner/editor/reviewer/viewer) | Needed for RLS + "reviewer" identity |
| `social_accounts` | workspace_id, platform, external_id, display_name, **encrypted_access_token**, **encrypted_refresh_token**, token_expires_at, status | Tokens AES-GCM/Fernet encrypted with key from env (or Supabase Vault); never returned by API |
| `content_projects` | workspace_id, name, niche, audience, business_description, platforms[], objective, status | A "campaign" |
| `research_items` | project_id, kind (goal/frustration/objection/question/workflow/pain_point/outcome/topic), text, source, confidence (known/unknown), agent_run_id | `unknown` allowed → NO GUESSING |
| `content_angles` | project_id, title, problem, target_audience, hook, content_angle, reason, suggested_format, platform, strength_score 0–100, status (generated/approved/rejected), diagnostic jsonb | |
| `content_drafts` | angle_id, platform, current_variant_id, status (DRAFT/REVIEW/APPROVED/REJECTED/SCHEDULED/PUBLISHED/FAILED) | Status is the single source of truth for the gate |
| `content_variants` | draft_id, version_no, hook, body, cta, hashtags[], extra jsonb (reel script…), source (ai/human), created_by | Version history; regenerate = new row, never overwrite |
| `content_calendar` | workspace_id, draft_id, social_account_id, scheduled_for, status, notes (visual missing, conflict flags) | |
| `approval_requests` | draft_id, variant_id, status (pending/approved/rejected), reviewer_id, decided_at, rejection_reason | Approval is bound to a **specific variant**; editing after approval invalidates it |
| `publishing_jobs` | draft_id, variant_id, platform, social_account_id, scheduled_at, status (QUEUED/PROCESSING/PUBLISHED/FAILED/CANCELLED), attempts, error_message, published_url, published_at, **idempotency_key UNIQUE** | |
| `publishing_results` | job_id, attempt_no, success, external_post_id, raw_response (redacted), error_code | One row per attempt |
| `analytics` | job_id/draft_id, platform, captured_at, impressions, likes, comments, shares, clicks, views, engagement_rate | Snapshots over time, not overwritten |
| `agent_runs` | workspace_id, execution_id, thread_id, agent_name, input jsonb, output jsonb, status, started_at, completed_at, error | Full trace |
| `audit_logs` | workspace_id, actor_id (nullable for system), action, entity_type, entity_id, before/after jsonb, ip | Append-only (no UPDATE/DELETE policy) |
| `learned_patterns` (Module 9) | workspace_id, pattern_type, description, evidence jsonb, observations_count, confidence | Only written after N ≥ threshold observations |

Relationship chain: `users → workspaces → social_accounts / content_projects → research_items → content_angles → content_drafts → content_variants → approval_requests → publishing_jobs → publishing_results → analytics`.

Indexes: `(workspace_id, status)` on drafts/jobs/calendar; `(scheduled_at) WHERE status='QUEUED'` on jobs; unique `(draft_id, version_no)`; unique `idempotency_key`; `(project_id)` on children.

**RLS:** enable on every tenant table; policy = `workspace_id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid())`. `audit_logs` is insert + select only. `social_accounts` token columns are not exposed through the public API (separate column grants / backend-only role). The backend uses a service role only for worker jobs and always re-checks workspace membership in code (defense in depth).

## 6. Agent architecture

Each agent: `Pydantic input → prompt+LLM (structured output) → Pydantic output`. The wrapper in `agents/base.py` writes an `agent_runs` row (execution ID, input, output, status, timestamps, error) and retries transient LLM errors.

| Agent | Input | Output | Must NOT |
|-------|-------|--------|----------|
| Research | niche, audience, business, platform, optional sources | `ResearchResult` (unknown allowed) | write posts, invent facts |
| Pattern | `ResearchResult` | `list[Angle]` + diagnostic verdicts | write posts; keep weak angles |
| Content | one **approved** angle + brand + platform + tone + objective | `ContentDraft` (status=draft) | change topic, publish |
| Organization | drafts + existing calendar | `CalendarProposal` (dates, times, flags) | approve or publish |
| Feedback | analytics snapshots + published drafts | `LearnedPattern[]` | rewrite research from one post |

Angle Diagnostic is deterministic code first (length, audience present, problem present, outcome present, blacklist of generic phrases), LLM second; weak angles are rejected with reasons.

## 7. LangGraph workflow (Module 10)

```
START → research → pattern → angle_validation ─► [interrupt: angle review]
      → content → organization → [interrupt: HUMAN APPROVAL GATE]
      → (approved?) publishing → analytics → feedback → END
              └─ rejected → END (or back to content with reason)
```

- State (TypedDict/Pydantic): `workspace_id, project_id, research, patterns, angles, drafts, calendar_items, approval_status, publishing_results, analytics`.
- Checkpointer: Postgres (`langgraph-checkpoint-postgres`), `thread_id = project_id`.
- The approval gate uses LangGraph `interrupt()`. The graph is resumed by the approval API **only after** the DB row is `APPROVED`; resume payload is re-verified against the DB (the graph never trusts its own state for approval).
- Each node is a thin call into one agent/service so it can be unit-tested alone.

## 8. Approval flow and the Golden Rule

```
DRAFT → REVIEW → APPROVED ─► SCHEDULED → PUBLISHED
              └─► REJECTED (terminal; new variant → back to DRAFT, never auto-APPROVED)
                              SCHEDULED/PROCESSING → FAILED → retry
```

- Transitions live in one function (`approval_service.transition`) with an explicit allowed-transitions table; anything else raises `IllegalTransition`.
- Every decision writes `approval_requests` (reviewer, timestamp, reason) **and** `audit_logs`.
- Editing an APPROVED variant creates a new variant and resets to REVIEW.
- **Three independent guards** against unapproved publishing:
  1. `publishing_service.enqueue` rejects if draft status ≠ APPROVED or no matching approved `approval_requests` row for the current variant.
  2. `publishing/validator.py` re-checks right before sending (worker path).
  3. Tool layer write methods (`create_post`, `schedule_post`) require an `ApprovalToken` that only `approval_service` can mint; adapters refuse without it.
- Agents have **no** access to the tool layer's write methods (read-only tool subset is injected into agents).

## 9. Social platform integration flow (Module 7)

```
Agent / Service  →  tools.schedule_content(draft_id)
                      └─ registry.get(platform) → PlatformAdapter
                            ├─ LinkedInAdapter  (UGC/Posts API, OAuth2)
                            ├─ FacebookAdapter  (Graph API, Page token)
                            └─ InstagramAdapter (Graph API, container → publish)
```

Interface: `get_connected_accounts, get_account_info, create_post, schedule_post, get_scheduled_posts, get_published_posts, get_post_metrics, validate_content`.

- `PLATFORM_MODE=mock|live` and `ALLOW_LIVE_PUBLISH=false` by default; live publishing needs both flags.
- Errors normalized: `AuthError`, `RateLimited(retry_after)`, `InvalidToken`, `UnsupportedContent`, `PlatformUnavailable`. Retryable = rate-limit + unavailable (exponential backoff, capped attempts).
- OAuth connect flow: frontend → `/accounts/{platform}/connect` → platform consent → callback → tokens encrypted → `social_accounts` row.
- Instagram requires an image/video; the Organization Agent flags "missing visual".

## 10. Authentication flow

1. Frontend signs up/in with Supabase Auth (email+password; OAuth later) via `@supabase/ssr`.
2. Next.js middleware protects `(app)` routes using the session cookie.
3. API client sends `Authorization: Bearer <supabase access token>`.
4. FastAPI `get_current_user` verifies the JWT (JWKS/HS256 secret from env), loads the profile.
5. `get_workspace_ctx` reads `X-Workspace-Id`, verifies membership + role, and every repository query is scoped by `workspace_id`.
6. Worker/scheduler uses a service credential, never a user token.

## 11. Scheduling flow

1. Organization Agent reads existing `content_calendar`, proposes slots (no duplicates, per-platform daily cap, fill gaps, best-time heuristics).
2. Proposal stored as calendar rows in `REVIEW`; human can drag-and-drop to reschedule (PATCH, re-runs conflict check).
3. After approval, `publishing_jobs` row is created with `idempotency_key = hash(variant_id, account_id, scheduled_at)`.
4. Worker polls `QUEUED AND scheduled_at <= now()` with `SELECT … FOR UPDATE SKIP LOCKED`, sets PROCESSING, validates, calls the tool layer, writes `publishing_results`, sets PUBLISHED/FAILED.
5. Metrics poller snapshots `analytics` at +1h, +24h, +7d.

## 12. API endpoints (`/api/v1`)

| Area | Endpoints |
|------|-----------|
| Health/Auth | `GET /health`, `GET /me` |
| Workspaces | `GET/POST /workspaces`, `GET /workspaces/{id}` |
| Accounts | `GET /accounts`, `POST /accounts/{platform}/connect`, `GET /accounts/{platform}/callback`, `DELETE /accounts/{id}` |
| Campaigns | `POST/GET /campaigns`, `GET/PATCH /campaigns/{id}`, `POST /campaigns/{id}/run` (start graph), `POST /campaigns/{id}/resume` |
| Research | `POST /research/run`, `GET /research?project_id=` |
| Angles | `POST /angles/generate`, `GET /angles`, `PATCH /angles/{id}` (edit), `POST /angles/{id}/approve`, `/reject` |
| Drafts | `POST /drafts/generate`, `GET /drafts`, `GET /drafts/{id}/versions`, `PATCH /drafts/{id}` (new version), `POST /drafts/{id}/regenerate`, `POST /drafts/{id}/submit-review` |
| Calendar | `GET /calendar`, `POST /calendar/organize`, `PATCH /calendar/{id}` (reschedule) |
| Approvals | `GET /approvals`, `POST /approvals/{draft_id}/approve`, `/reject` (reason required) |
| Publishing | `POST /publishing/enqueue`, `GET /publishing/jobs`, `POST /publishing/jobs/{id}/retry`, `/cancel` |
| Analytics | `GET /analytics/summary`, `/top-posts`, `/platforms`, `/posts/{id}/explain`, `POST /analytics/sync` |
| Dashboard | `GET /dashboard/overview`, `GET /runs` |

All routes: auth dependency, workspace dependency, Pydantic request/response models, consistent error envelope `{error:{code,message,request_id}}`.

## 13. Frontend modules

`Auth`, `Dashboard` (pipeline + stats), `Campaign Wizard` (9 steps), `Research`, `Angles`, `Content Studio` (edit, regenerate, versions), `Calendar` (drag-and-drop), `Approvals` (confirm dialog), `Publishing Queue`, `Analytics`. Each feature folder owns its API hooks, types (zod-validated), and components. Agent internals are hidden from the user; only status chips and results appear.

## 14. Cross-cutting concerns

- **Logging:** structlog JSON, `request_id` + `workspace_id` + `execution_id` bound per request; tokens, emails, and post bodies are not logged at INFO.
- **Errors:** `AppError` hierarchy mapped to HTTP codes; agent failures recorded in `agent_runs.error` and surfaced as retryable states.
- **Prompt injection:** all research/user text is passed to LLMs as delimited data, outputs are schema-validated, agents have no write tools.
- **Config:** single `Settings` class; `.env.example` committed, real `.env` git-ignored.

## 15. Build order and decisions to confirm before Module 1

Order: 1 DB/Auth → 2 Research → 3 Pattern → 4 Content → 5 Organization → 6 Approval → 7 Tools → 8 Publishing → 9 Analytics → 10 LangGraph → 11 Dashboard → 12 Hardening.

Decisions I will default to unless told otherwise:
1. **ORM/driver:** SQLAlchemy 2 + asyncpg for queries. No Alembic: Supabase SQL migrations are the single schema source of truth, and the models map to them.
2. **LLM provider:** Anthropic Claude via LangChain (`langchain-anthropic`), model name from env.
3. **Supabase:** local via Supabase CLI/Docker if available; otherwise plain Postgres + a JWT test issuer for tests.
4. **Package managers:** `uv` for Python, `pnpm` (or npm) for the frontend.
5. **Folder:** everything lives in `content-engine/` so the existing profile `README.md` is untouched.
