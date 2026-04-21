# Alpha Mind - Project Summary

주식 자동매매 + AI 종목 분석 플랫폼.

## Tech Stack

| Layer | Tech |
|---|---|
| Monorepo | pnpm workspace (`apps/*`, `libs/*`) |
| Backend | NestJS 11, MikroORM 6, PostgreSQL 17, RabbitMQ, WebSocket |
| Market Data / AI | NestJS 11, Yahoo Finance API, cache-manager, Claude Code CLI, Codex CLI |
| Frontend | React 19, React Router 7, Vite 6, TypeScript, 순수 CSS |
| Infra | Docker Compose, nginx reverse proxy |

## Directory Structure

```text
alpha-mind/
├── README.md                   # 설치/실행/기능 설명
├── SUMMARY.md                  # 현재 문서
├── docker-compose.yml          # postgres, rabbitmq, backend, market-data, frontend
├── package.json                # root scripts: dev, build, lint, format
├── pnpm-workspace.yaml         # packages: apps/*, libs/*
│
├── apps/
│   ├── backend/                # :3000, API prefix: /api
│   │   ├── Dockerfile
│   │   ├── .env / .env.example
│   │   └── src/
│   │       ├── main.ts                     # WsAdapter, Swagger, GlobalPrefix 'api'
│   │       ├── app.module.ts               # AuthGuard + RbacGuard + AllExceptionFilter
│   │       ├── auth/                       # JWT 인증/토큰 관리
│   │       │   ├── auth.controller.ts
│   │       │   ├── auth.service.ts
│   │       │   └── entities/user-auth-token.entity.ts
│   │       ├── user/                       # 사용자 CRUD + 관리자 기능
│   │       │   ├── user.controller.ts
│   │       │   ├── user.service.ts
│   │       │   ├── entities/user.entity.ts
│   │       │   └── dto/                    # sign-up, sign-in, update-user, admin-update-user
│   │       ├── kis/                        # 한국투자증권 OpenAPI 연동
│   │       │   ├── kis.controller.ts       # 주문/잔고/시세/일지 REST
│   │       │   ├── kis.service.ts          # KIS 토큰 관리
│   │       │   ├── kis-order.service.ts    # 매수/매도/정정/취소
│   │       │   ├── kis-inquiry.service.ts  # 잔고/주문내역 조회
│   │       │   ├── kis-quotation.service.ts # 시세/일봉 조회
│   │       │   ├── kis-journal.service.ts  # 매매 일지
│   │       │   ├── kis-websocket.service.ts # KIS WebSocket 클라이언트
│   │       │   ├── kis-websocket.gateway.ts # 프론트엔드 WS 게이트웨이
│   │       │   ├── dto/                    # order-cash, order-modify, order-cancel
│   │       │   └── entities/               # trade-history, trade-daily-summary
│   │       ├── auto-trading/               # 자동매매 세션/예약 스캔 관리
│   │       │   ├── auto-trading.controller.ts
│   │       │   ├── auto-trading.service.ts
│   │       │   ├── auto-trading.gateway.ts
│   │       │   ├── scheduled-scanner.service.ts # 평일 08:00 자동 스캔 후 세션 시작/재개
│   │       │   ├── dto/start-session.dto.ts
│   │       │   └── entities/auto-trading-session.entity.ts
│   │       ├── notification/               # 알림 목록/읽음 처리/삭제
│   │       │   ├── notification.controller.ts
│   │       │   ├── notification.service.ts
│   │       │   └── entities/notification.entity.ts
│   │       ├── ai-meeting-result/          # AI 분석 결과 저장/조회
│   │       │   ├── ai-meeting-result.controller.ts
│   │       │   ├── ai-meeting-result.service.ts
│   │       │   └── entities/ai-meeting-result.entity.ts
│   │       ├── rmq/rmq.module.ts           # RabbitMQ 연결 (market_data_queue)
│   │       ├── health/                     # /api/health
│   │       ├── common/logger.config.ts
│   │       ├── decorator/user.decorator.ts
│   │       ├── config/
│   │       │   ├── mikro-orm.config.ts
│   │       │   └── validation.schema.ts
│   │       └── migrations/                 # Migration20260328~20260421
│   │
│   ├── market-data-service/    # :3001, nginx에서 /market-api 로 프록시
│   │   ├── Dockerfile          # Claude CLI + Codex CLI 실행 환경
│   │   ├── .env / .env.example
│   │   ├── data/
│   │   │   ├── krx_codes.csv       # KRX 종목 코드 목록
│   │   │   └── rx_sector_map.csv   # 종목-섹터 매핑
│   │   ├── document/kis-api/       # KIS 문서 보관
│   │   └── src/
│   │       ├── main.ts                     # HTTP + RabbitMQ microservice
│   │       ├── market-data-service.module.ts # AuthGuard, CacheModule, ScheduleModule
│   │       ├── stock/                      # 차트 데이터 수집 + 관리
│   │       │   ├── stock.controller.ts     # /stocks, /stocks/:code, /stocks/collection-status
│   │       │   ├── stock.service.ts        # SavePoint 기반 이어서 수집 + Cron
│   │       │   └── entities/
│   │       │       ├── stock.entity.ts
│   │       │       ├── stock-daily-price.entity.ts
│   │       │       └── stock-collection-savepoint.entity.ts
│   │       ├── yahoo-finance/              # Yahoo Finance v8 API 클라이언트
│   │       │   ├── yahoo-finance.controller.ts
│   │       │   ├── yahoo-finance.service.ts
│   │       │   └── yahoo-finance.types.ts
│   │       ├── strategy/                   # 전략 분석 + 백테스트 + 스캐너
│   │       │   ├── strategy.controller.ts
│   │       │   ├── strategy.service.ts
│   │       │   ├── backtest.service.ts
│   │       │   ├── dto/                    # backtest-query, scan-query, strategy-query
│   │       │   └── types/                  # backtest, scan 타입
│   │       ├── ai-scoring/                 # Claude/GPT 멀티 에이전트 분석
│   │       │   ├── ai-scoring.controller.ts # score, score-stream, background-session API
│   │       │   ├── ai-scoring.service.ts    # 3단계 분석 오케스트레이션 + 결과 저장
│   │       │   ├── claude-pty.ts            # Claude CLI 실행기
│   │       │   ├── gpt-pty.ts               # Codex CLI 실행기
│   │       │   └── types/ai-scoring.types.ts
│   │       ├── agent-config/               # Claude/GPT 인증 설정 관리
│   │       │   ├── agent-config.controller.ts # 상태 조회, API 키 검증, Claude login, GPT auth import
│   │       │   ├── agent-config.service.ts    # .agents/config.json + ~/.claude + ~/.codex 관리
│   │       │   └── agent-config.module.ts
│   │       ├── health/                     # /health
│   │       ├── common/logger.config.ts
│   │       ├── config/
│   │       │   ├── mikro-orm.config.ts
│   │       │   └── validation.schema.ts
│   │       └── migrations/                 # Migration20260327~
│   │
│   └── frontend/               # :80 (nginx) / :5173 (vite dev)
│       ├── Dockerfile          # Vite build → nginx
│       ├── nginx.conf          # /api, /market-api, /ws 프록시
│       ├── vite.config.ts      # dev proxy: /api, /market-api, /ws
│       └── src/
│           ├── main.tsx
│           ├── App.tsx                     # BrowserRouter, 라우팅 정의
│           ├── index.css                   # 전역 스타일
│           ├── components/
│           │   ├── Layout.tsx              # 사이드바 + 상단 바
│           │   ├── AutoTradingConfigModal.tsx
│           │   ├── CollectionStatus.tsx
│           │   ├── ConnectionIndicator.tsx
│           │   ├── NotificationBell.tsx
│           │   ├── SessionConflictModal.tsx
│           │   └── ProtectedRoute.tsx      # ProtectedRoute + AdminRoute
│           ├── contexts/
│           │   ├── AuthContext.tsx
│           │   └── ThemeContext.tsx
│           ├── hooks/
│           │   ├── useKisWebSocket.ts
│           │   ├── useAutoTradingWebSocket.ts
│           │   └── useConnectionStatus.ts
│           ├── api/
│           │   ├── client.ts               # backend API 클라이언트
│           │   ├── market-client.ts        # market-data API 클라이언트
│           │   ├── auth.ts, user.ts, kis.ts, backtest.ts
│           │   ├── auto-trading.ts, ai-meeting-result.ts, notification.ts
│           │   └── scanner.ts, stocks.ts
│           ├── types/                      # user, kis, auto-trading, scanner 타입
│           └── pages/
│               ├── Dashboard.tsx           # /
│               ├── SignIn.tsx              # /sign-in
│               ├── SignUp.tsx              # /sign-up
│               ├── Profile.tsx             # /profile
│               ├── trading/
│               │   ├── Balance.tsx         # /trading/balance
│               │   ├── StockSearch.tsx     # /trading/search
│               │   ├── Order.tsx           # /trading/order
│               │   └── Journal.tsx         # /trading/journal
│               ├── Backtest.tsx            # /backtest
│               ├── AiScanner.tsx           # /ai-scanner
│               ├── AgentSettings.tsx       # /agent-settings
│               └── admin/
│                   ├── UserList.tsx        # /admin/users
│                   └── UserEdit.tsx        # /admin/users/:id
│
├── libs/
│   ├── common/                 # @alpha-mind/common
│   │   └── src/
│   │       ├── index.ts
│   │       ├── enums/user-role.enum.ts
│   │       ├── decorator/      # @Public(), @Roles()
│   │       ├── guard/          # AuthGuard, RbacGuard
│   │       └── filter/         # AllExceptionFilter
│   │
│   └── strategies/             # @alpha-mind/strategies
│       └── src/
│           ├── index.ts
│           ├── types/strategy.types.ts
│           ├── indicators/technical-indicators.ts  # SMA, RSI, Bollinger, ATR, OBV 등
│           └── strategies/
│               ├── day-trading.strategy.ts
│               ├── mean-reversion.strategy.ts
│               ├── infinity-bot.strategy.ts
│               ├── candle-pattern.strategy.ts
│               ├── momentum-power.strategy.ts
│               └── momentum-surge.strategy.ts
│
├── .agents/                    # Claude/GPT 인증 설정 저장 (gitignored)
│   └── config.json             # { claude: {...}, gpt: {...}, ...legacy top-level fields }
└── .claude/
    └── skills/kis-api/         # 로컬 Claude 프롬프트/자료 자산
```

> 구독 모드에서는 Claude는 `~/.claude/.credentials.json`, GPT(Codex)는 `~/.codex/auth.json`을 사용합니다.
> Docker에서는 각각 `claude_credentials`, `codex_credentials` 볼륨으로 유지됩니다.

## Key Architecture Decisions

### AI 종목 분석 (3단계 멀티 에이전트)
`AiScoringService`가 Claude 또는 GPT(Codex) CLI를 실행해 종목별 분석 세션을 오케스트레이션합니다.
- **Phase 1**: 뉴스 에이전트 + 차트 에이전트 병렬 수집
- **Phase 2**: 트레이더 + 경제 분석가 병렬 분석
- **Phase 3**: 두 의견을 종합해 최종 점수와 추천 생성
- Claude 실행기: `claude-pty.ts`
  `claude -p --model sonnet --output-format text --allowedTools WebSearch,WebFetch,Read,Glob,Grep`
- GPT 실행기: `gpt-pty.ts`
  `codex --search exec --skip-git-repo-check --sandbox read-only ...`
- 호출 전 `ensureAuth(provider)`로 설정을 검증하고, 실패하면 fallback 점수를 반환합니다.
- 장시간 작업은 background session으로 유지되어 프론트가 재연결하거나 취소할 수 있습니다.

### 에이전트 인증 체계 (Claude + GPT)
`AgentConfigService` + `/agents/*` 엔드포인트 + `AgentSettings.tsx` UI가 담당합니다.

| Provider | 모드 | 저장 항목 | 실제 사용 경로 |
|---|---|---|---|
| Claude | `api_key` | `anthropicApiKey` | `ANTHROPIC_API_KEY` |
| Claude | `subscription` | `oauthAccessToken`, `oauthRefreshToken`, `oauthExpiresAt` | `~/.claude/.credentials.json` |
| GPT | `api_key` | `openaiApiKey` | `OPENAI_API_KEY` |
| GPT | `subscription` | `.agents/config.json` 상태 + Codex 로그인 정보 | `~/.codex/auth.json` |

**Claude 구독 플로우**
1. `POST /agents/login`으로 OAuth PKCE 로그인 URL 생성
2. 사용자가 Claude 로그인 후 code 획득
3. `POST /agents/login/code`로 토큰 교환
4. 서버가 `.agents/config.json`과 `~/.claude/.credentials.json` 동시 갱신
5. `ensureValidOAuthToken()`이 만료 5분 전 자동 refresh 수행

**GPT 구독 플로우**
1. 로컬에서 로그인된 Codex `auth.json` 준비
2. `POST /agents/gpt/auth/import`로 서버에 가져오기
3. `POST /agents/config`에서 `provider=gpt`, `authMode=subscription` 저장
4. `GET /agents/login/status?provider=gpt`로 상태 확인

### 차트 데이터 수집 (StockService)
- `onModuleInit`에서 누락 종목 또는 최신 거래일 미반영 상태를 감지하면 `collectAll()`을 백그라운드 실행합니다.
- 평일 17:00 KST Cron으로 자동 수집합니다.
- SavePoint 기반 이어받기 수집을 사용합니다.
- `/stocks/collection-status`를 통해 `collecting`, `progress`, `lastCompletedAt` 상태를 노출합니다.
- 프론트 `CollectionStatus`가 5초 간격으로 상태를 폴링합니다.

### 자동매매 예약 스캔
- `ScheduledScannerService`가 평일 08:00 KST에 예약 스캔을 수행합니다.
- `strategy.scan`을 RabbitMQ로 호출해 매수 후보를 받은 뒤:
  active 세션은 제외하고, `AUTO_SELL`로 멈춘 세션은 재개, 신규 종목은 monitor 모드로 시작합니다.
- 실행 충돌 방지를 위해 `scheduled_job_locks` 테이블을 사용합니다.

### Docker Compose 구성
```text
postgres:5432 ← backend:3000 (/api)
                 market-data:3001 (/market-api)
                 rabbitmq:5672/15672
frontend:80 (nginx) → backend, market-data, ws
```
- 볼륨:
  `postgres_data`, `rabbitmq_data`, `backend_logs`, `market_data_logs`
- 인증/설정 볼륨:
  `agents_data` → `/app/.agents`
  `claude_credentials` → `/root/.claude`
  `codex_credentials` → `/root/.codex`
- nginx 라우팅:
  `/api/` → backend
  `/market-api/ai-scoring/score-stream` → market-data (SSE 전용 타임아웃 확장)
  `/market-api/` → market-data
  `/ws/` → backend WebSocket

### 인증 체계
- **backend**: JWT `AuthGuard` + `RbacGuard`
- **market-data-service**: JWT `AuthGuard`, `@Public()`로 예외 처리
- 대표 Public 엔드포인트:
  `/stocks/collection-status`
  `/agents/status`
  `/agents/login/status`

### Frontend 레이아웃
- **좌측 사이드바**: 잔고 / 종목 조회 / 매매 / 매매 일지 / 백테스팅 / AI 종목 추천 / AI 설정 / 관리자
- **상단 바**: 서버 시간, `CollectionStatus`, `NotificationBell`, `ConnectionIndicator`, 테마 토글, 유저 메뉴
- **API 계층**: backend용 `client.ts`, market-data용 `market-client.ts` 분리
- **AgentSettings**: Claude/GPT 각각 `api_key` / `subscription` 모드 지원

## Database (PostgreSQL)

### Backend Entities
- `User` (`users`) - username, email, name, password, role
- `UserAuthToken` (`user_auth_tokens`) - refreshToken, expiresAt
- `TradeHistory` (`trade_histories`) - 매매 기록
- `TradeDailySummary` (`trade_daily_summaries`) - 일별 매매 요약
- `AutoTradingSession` (`auto_trading_sessions`) - 자동매매 세션
- `Notification` (`notifications`) - 읽음 상태 포함 사용자 알림
- `AiMeetingResult` (`ai_meeting_results`) - 사용자별 종목 AI 분석 결과

### Market Data Entities
- `Stock` (`stocks`) - code, name, sector, currency, exchange
- `StockDailyPrice` (`stock_daily_prices`) - date, OHLCV, adjClose
- `StockCollectionSavepoint` (`stock_collection_savepoints`) - lastCollectedDate

## Dev Commands

```bash
pnpm dev                    # 전체 (backend + market-data + frontend 병렬)
pnpm dev:backend            # backend만 (:3000)
pnpm dev:market-data        # market-data-service만 (:3001)
pnpm dev:frontend           # frontend만 (:5173 vite dev)
pnpm build                  # 전체 빌드
pnpm lint                   # 전체 lint

docker compose up -d
docker compose up -d --build
```

## Environment Variables

### backend/.env
```env
NODE_ENV
PORT
DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_DATABASE
JWT_SECRET, JWT_EXPIRES_IN
KIS_APP_KEY, KIS_APP_SECRET
KIS_ACCOUNT_NO, KIS_ACCOUNT_PROD_CD
KIS_HTS_ID
KIS_ENV                    # sandbox | production
RMQ_URL
SCHEDULED_TRADER_USER_ID   # 미설정 시 예약 스캔 비활성화
```

### market-data-service/.env
```env
NODE_ENV
PORT
DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_DATABASE
JWT_SECRET
RMQ_URL
CLAUDE_CLI_PATH
CODEX_CLI_PATH
CODEX_HOME
AGENTS_CONFIG_DIR
```

> Claude 구독 모드는 `~/.claude/.credentials.json`, GPT 구독 모드는 `~/.codex/auth.json`을 사용합니다.
