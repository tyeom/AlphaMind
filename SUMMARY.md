# Alpha Mind - Project Summary

주식 자동매매 + AI 종목 분석 플랫폼.

## Tech Stack

| Layer | Tech |
|---|---|
| Monorepo | pnpm workspace (`apps/*`, `libs/*`) |
| Backend | NestJS 11, MikroORM 6, PostgreSQL 17, RabbitMQ |
| Market Data | NestJS 11, Yahoo Finance API, Claude Code CLI (AI 분석), OAuth PKCE |
| Frontend | React 19, React Router 7, Vite 6, 순수 CSS (UI 라이브러리 없음) |
| Infra | Docker Compose, nginx reverse proxy |

## Directory Structure

```
alpha-mind/
├── docker-compose.yml          # postgres, rabbitmq, backend, market-data, frontend
├── package.json                # root scripts: dev, dev:backend, dev:market-data, dev:frontend
├── pnpm-workspace.yaml         # packages: apps/*, libs/*
│
├── apps/
│   ├── backend/                # :3000  API prefix: /api
│   │   ├── Dockerfile
│   │   ├── .env / .env.example
│   │   └── src/
│   │       ├── main.ts                     # WsAdapter, Swagger (/api/swagger), GlobalPrefix 'api'
│   │       ├── app.module.ts               # AuthGuard + RbacGuard (APP_GUARD)
│   │       ├── auth/                       # JWT 인증 (sign-in, sign-up, refresh)
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
│   │       │   ├── kis-websocket.service.ts     # KIS WebSocket 클라이언트
│   │       │   ├── kis-websocket.gateway.ts     # 프론트엔드 WS 게이트웨이
│   │       │   └── entities/               # trade-history, trade-daily-summary
│   │       ├── auto-trading/               # 자동매매 세션 관리
│   │       │   ├── auto-trading.controller.ts
│   │       │   ├── auto-trading.service.ts
│   │       │   ├── auto-trading.gateway.ts # WS: 실시간 가격/체결 알림
│   │       │   └── entities/auto-trading-session.entity.ts
│   │       ├── rmq/rmq.module.ts           # RabbitMQ 연결 (market_data_queue)
│   │       ├── health/                     # /api/health (Terminus)
│   │       ├── config/
│   │       │   ├── mikro-orm.config.ts
│   │       │   └── validation.schema.ts
│   │       └── migrations/                 # Migration20260328~20260401
│   │
│   ├── market-data-service/    # :3001  (no prefix)
│   │   ├── Dockerfile          # Claude Code CLI 설치 (npm -g @anthropic-ai/claude-code)
│   │   ├── .env / .env.example
│   │   ├── data/
│   │   │   ├── krx_codes.csv       # KRX 종목 코드 목록
│   │   │   └── rx_sector_map.csv   # 종목-섹터 매핑
│   │   └── src/
│   │       ├── main.ts                     # HTTP + RabbitMQ microservice
│   │       ├── market-data-service.module.ts # AuthGuard (APP_GUARD), 글로벌 인증
│   │       ├── stock/                      # 차트 데이터 수집 + 관리
│   │       │   ├── stock.controller.ts     # GET /stocks, /stocks/:code, /stocks/collection-status (@Public)
│   │       │   ├── stock.service.ts        # Yahoo Finance 차트 수집, SavePoint 기반 이어서 수집
│   │       │   │                           # onModuleInit: 백그라운드 수집 (await 없음)
│   │       │   │                           # Cron: 평일 17:00 KST 자동 수집
│   │       │   │                           # CollectionStatus: collecting/progress/lastCompletedAt
│   │       │   └── entities/
│   │       │       ├── stock.entity.ts                  # stocks 테이블
│   │       │       ├── stock-daily-price.entity.ts      # stock_daily_prices 테이블
│   │       │       └── stock-collection-savepoint.entity.ts # 수집 진행 상태 추적
│   │       ├── yahoo-finance/              # Yahoo Finance v8 API 클라이언트
│   │       │   ├── yahoo-finance.service.ts # getChartByPeriod(), 재시도/쓰로틀링
│   │       │   └── yahoo-finance.types.ts
│   │       ├── strategy/                   # 전략 분석 + 백테스트 + 스캐너
│   │       │   ├── strategy.controller.ts  # /strategies, /strategies/backtest, /strategies/scan
│   │       │   ├── strategy.service.ts     # 전략 실행 (day-trading, mean-reversion 등)
│   │       │   ├── backtest.service.ts     # 백테스트 시뮬레이션
│   │       │   └── types/                  # strategy, backtest, scan 타입
│   │       ├── ai-scoring/                 # 3단계 멀티 에이전트 AI 분석
│   │       │   ├── ai-scoring.controller.ts # POST /ai-scoring/score-stream (SSE), /ai-scoring/score, RMQ 'ai_scoring.score'
│   │       │   │                            # SSE 시작 전 ensureAuth() 호출 → OAuth 토큰 사전 검증/갱신
│   │       │   ├── ai-scoring.service.ts    # Phase1: 뉴스+차트, Phase2: 트레이더+분석가, Phase3: 회의
│   │       │   │                            # ensureAuth(): AgentConfigService.ensureValidOAuthToken() 호출
│   │       │   │                            # 실패 시 OAUTH_EXPIRED_MSG 반환 → 재로그인 유도
│   │       │   ├── claude-pty.ts            # Claude Code CLI spawn (--model sonnet, --output-format text)
│   │       │   │                            # --allowedTools: WebSearch,WebFetch,Read,Glob,Grep
│   │       │   │                            # api_key 모드: ANTHROPIC_API_KEY 환경변수로 전달
│   │       │   │                            # subscription 모드: CLI가 ~/.claude/.credentials.json의 OAuth 토큰 사용
│   │       │   │                            # "You've hit your limit" 감지 → 즉시 SIGTERM + TOKEN_LIMIT_MSG
│   │       │   └── types/ai-scoring.types.ts
│   │       ├── agent-config/               # Claude Code 인증 설정 관리 (API 키 + OAuth PKCE)
│   │       │   ├── agent-config.controller.ts # 설정/검증:
│   │       │   │                              #   GET  /agents/status       (@Public) — 인증 상태
│   │       │   │                              #   POST /agents/config       — authMode+키 저장
│   │       │   │                              #   POST /agents/verify       — API 키 유효성 검증
│   │       │   │                              # OAuth PKCE (구독 모드):
│   │       │   │                              #   POST /agents/login        — 인증 URL 생성
│   │       │   │                              #   POST /agents/login/code   — code → 토큰 교환
│   │       │   │                              #   GET  /agents/login/status (@Public) — 로그인 여부
│   │       │   ├── agent-config.service.ts    # .agents/config.json 읽기/쓰기
│   │       │   │                              # PKCE: code_verifier/challenge 생성 + state (CSRF)
│   │       │   │                              # OAuth Token URL: https://console.anthropic.com/v1/oauth/token
│   │       │   │                              # refresh_token 자동 갱신 (만료 5분 전 감지)
│   │       │   │                              # CLI용 ~/.claude/.credentials.json 동기화 (mode 0o600)
│   │       │   │                              # API 키 검증: https://api.anthropic.com/v1/messages 호출
│   │       │   └── agent-config.module.ts     # AgentConfigService export (AiScoringModule에서 사용)
│   │       ├── health/                     # /health (Terminus)
│   │       ├── config/
│   │       │   ├── mikro-orm.config.ts
│   │       │   └── validation.schema.ts
│   │       └── migrations/                 # Migration20260327~
│   │
│   └── frontend/               # :80 (nginx) / :5173 (vite dev)
│       ├── Dockerfile          # Vite build → nginx
│       ├── nginx.conf          # /api → backend:3000, /market-api → market-data:3001, /ws → WS
│       ├── vite.config.ts      # dev proxy: /api, /market-api, /ws
│       └── src/
│           ├── main.tsx
│           ├── App.tsx                     # BrowserRouter, 라우팅 정의
│           ├── index.css                   # 전체 스타일 (라이트/다크 테마, CSS 변수)
│           ├── components/
│           │   ├── Layout.tsx              # 좌측 사이드바 (expand/collapse) + 상단 바
│           │   │                           # 7개 메뉴 (+ 관리자): 잔고/조회/매매/일지/백테스팅/AI스캐너/Claude 설정
│           │   ├── CollectionStatus.tsx    # market-data 수집 상태 5초 폴링 (대기/수집중/완료/에러)
│           │   ├── ConnectionIndicator.tsx # WS 연결 상태 (good/unstable/disconnected)
│           │   └── ProtectedRoute.tsx      # 인증/관리자 가드
│           ├── contexts/
│           │   ├── AuthContext.tsx          # JWT 인증 상태 관리
│           │   └── ThemeContext.tsx         # 라이트/다크 테마 (쿠키 저장)
│           ├── hooks/
│           │   ├── useKisWebSocket.ts      # KIS 실시간 데이터 WS
│           │   ├── useAutoTradingWebSocket.ts # 자동매매 WS
│           │   └── useConnectionStatus.ts  # ping/pong 연결 모니터링
│           ├── api/                        # fetch 기반 HTTP 클라이언트 (axios 미사용)
│           │   ├── client.ts              # api.get/post/patch/delete + JWT 자동 주입
│           │   ├── auth.ts, user.ts, kis.ts, backtest.ts, auto-trading.ts, scanner.ts
│           ├── types/                      # user, kis, auto-trading, scanner 타입
│           └── pages/
│               ├── Dashboard.tsx           # /
│               ├── SignIn.tsx              # /sign-in
│               ├── SignUp.tsx              # /sign-up
│               ├── Profile.tsx            # /profile
│               ├── trading/
│               │   ├── Balance.tsx         # /trading/balance    잔고 조회
│               │   ├── StockSearch.tsx     # /trading/search     종목 시세
│               │   ├── Order.tsx           # /trading/order      매수/매도
│               │   └── Journal.tsx         # /trading/journal    매매 일지
│               ├── Backtest.tsx            # /backtest           전략 백테스트
│               ├── AiScanner.tsx           # /ai-scanner         AI 종목 추천 (SSE 스트리밍)
│               ├── AgentSettings.tsx       # /agent-settings     Claude Code 인증 마법사
│               │                           # 탭: API 키 / Claude 구독 (OAuth PKCE)
│               │                           # 1단계 로그인 → 브라우저 → 코드 → 2단계 제출
│               └── admin/
│                   ├── UserList.tsx        # /admin/users
│                   └── UserEdit.tsx        # /admin/users/:id
│
├── libs/
│   ├── common/                 # @alpha-mind/common
│   │   └── src/
│   │       ├── index.ts        # exports: UserRole, Public, Roles, AuthGuard, RbacGuard, AllExceptionFilter
│   │       ├── enums/user-role.enum.ts
│   │       ├── decorator/      # @Public(), @Roles()
│   │       ├── guard/          # AuthGuard (JWT), RbacGuard (역할 기반)
│   │       └── filter/         # AllExceptionFilter
│   │
│   └── strategies/             # @alpha-mind/strategies
│       └── src/
│           ├── index.ts        # exports: 모든 전략 + 지표 + 타입
│           ├── types/strategy.types.ts     # CandleData, Signal, StrategyAnalysisResult, 전략별 Config
│           ├── indicators/technical-indicators.ts  # SMA, RSI, Bollinger, ATR 등
│           └── strategies/
│               ├── day-trading.strategy.ts     # 데이트레이딩 (breakout/crossover/volume_surge)
│               ├── mean-reversion.strategy.ts  # 평균회귀 (RSI/bollinger/grid/magic_split)
│               ├── infinity-bot.strategy.ts    # 무한매수법
│               └── candle-pattern.strategy.ts  # 캔들패턴 (18종 패턴 인식)
│
└── .agents/                    # Claude Code 인증 (gitignored, Docker 볼륨 agents_data)
    └── config.json             # { "authMode": "api_key" | "subscription",
                                 #   "anthropicApiKey": "sk-ant-...",
                                 #   "oauthAccessToken": "...", "oauthRefreshToken": "...",
                                 #   "oauthExpiresAt": "2026-04-06T12:34:56.000Z" }
```

> 구독 모드에서는 `~/.claude/.credentials.json` (컨테이너의 `/root/.claude` — 볼륨 `claude_credentials`)도 같이 생성됩니다. Claude Code CLI가 이 파일의 `claudeAiOauth` 블록을 읽어 실제 호출에 OAuth 토큰을 사용합니다.

## Key Architecture Decisions

### AI 종목 분석 (3단계 멀티 에이전트)
Claude Code CLI를 `child_process.spawn`으로 실행 (`claude-pty.ts`).
- **Phase 1** (병렬): 뉴스 에이전트 + 차트 에이전트 → 데이터 수집
- **Phase 2** (병렬): 주식 전문가 트레이더 + 경제 전문 분석가 → 분석
- **Phase 3** (직렬): 투자위원회 의장 → 최종 점수 결정
- 모델: `--model sonnet`, 출력: `--output-format text`
- 허용 도구: `--allowedTools WebSearch,WebFetch,Read,Glob,Grep`
- 호출 전처리: `AiScoringService.ensureAuth()` → OAuth 토큰 만료 5분 전 감지 시 `refresh_token`으로 자동 갱신 (SSE 진입 시점에 선 검증)
- 인증 모드(후술): `api_key` → `ANTHROPIC_API_KEY` 주입, `subscription` → 환경변수 미설정 (CLI가 `~/.claude/.credentials.json`의 OAuth 토큰 사용)
- Rate limit: `"You've hit your limit"` 감지 시 즉시 `SIGTERM` + `TOKEN_LIMIT_MSG`("토큰 한도가 100%로 꽉 찼습니다.") 반환 → 분석 루프 중단

### Claude Code 인증 체계 (API 키 + OAuth PKCE)
`AgentConfigService` + `/agents/*` 엔드포인트 + `AgentSettings.tsx` 마법사 UI로 구성.

**두 가지 모드** — `.agents/config.json`의 `authMode` 필드로 결정:

| 모드 | 저장 항목 | CLI 전달 방식 |
|---|---|---|
| `api_key` | `anthropicApiKey` | `ANTHROPIC_API_KEY` 환경변수 |
| `subscription` | `oauthAccessToken`, `oauthRefreshToken`, `oauthExpiresAt` | `~/.claude/.credentials.json` (CLI가 직접 읽음) |

**OAuth PKCE 플로우** (CLI 미사용, 순수 HTTP — `claude login` 서브프로세스를 띄우지 않음):
1. `POST /agents/login` → 서버가 `code_verifier`/`code_challenge`/`state` 생성 후
   `https://claude.ai/oauth/authorize?...&code_challenge_method=S256` URL 반환 → 프론트가 새 창으로 열기
2. 사용자가 Claude에서 로그인 완료 → 콜백 페이지에 표시된 authorization code를 복사
3. `POST /agents/login/code` `{ code }` → 서버가 `https://console.anthropic.com/v1/oauth/token`에
   `grant_type=authorization_code` + PKCE verifier로 교환 → `access_token`+`refresh_token` 획득
4. 서버는 토큰을 `.agents/config.json` 그리고 CLI용 `~/.claude/.credentials.json` 양쪽에 저장
   (`claudeAiOauth.{accessToken, refreshToken, expiresAt, scopes}`, 파일 모드 `0o600`)
5. `GET /agents/login/status` (@Public) → 토큰 존재/만료 확인, 만료 시 자동 `refresh_token` 갱신

**토큰 갱신 (`ensureValidOAuthToken`)**: 만료까지 5분 미만이면 자동으로 `refresh_token`을 사용해
`/v1/oauth/token` 호출 → config.json + `.credentials.json` 양쪽 갱신. AI 스코어링 호출 직전에 실행.

**API 키 모드**: `/agents/verify`에서 `https://api.anthropic.com/v1/messages`에 `max_tokens:1`로
테스트 호출 → 401이 아니면 유효로 판정.

**중요 제약**:
- `ANTHROPIC_AUTH_TOKEN` 환경변수로 OAuth 토큰을 직접 넘기면 API가 거부하므로 **절대 사용하지 않음**.
  CLI가 `.credentials.json`에서 직접 읽도록 파일만 관리.
- OAuth 스코프: `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`
- Client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (Claude Code 공식 CLI와 동일)

### 차트 데이터 수집 (StockService)
- `onModuleInit`:
  1. `krx_codes.csv` 중 savepoint가 없는 종목 수(`missingCount`) 계산
  2. `needsCatchUpCollection()`로 `max(last_collected_date)`이 `getLatestCollectionTargetDate()`보다 뒤처졌는지 확인
  3. 둘 중 하나라도 해당되면 `collectAll()`을 **백그라운드** 실행 (await 없음 → HTTP 서버 즉시 기동)
- `getLatestCollectionTargetDate()`: KST 기준 가장 최근 평일 17:00이 지난 날짜 반환
  (주말·17시 이전 평일은 직전 거래일로 보정)
- Cron: 평일(월~금) 17:00 KST 자동 수집 (`@Cron timeZone: 'Asia/Seoul'`)
- 3개월 rolling window: 3개월 이전 데이터는 `collectStock()`에서 자동 삭제
- SavePoint 기반 이어서 수집: `lastCollectedDate + 1일`부터 조회, 주말이면 다음 거래일로 보정
- 상태 추적: `getCollectionStatus() → { collecting, progress:{done,total}, lastCompletedAt }`
  → `/stocks/collection-status` (@Public) 엔드포인트로 노출 → 프론트 `CollectionStatus` 컴포넌트가 5초 폴링
- `stocks:all` / `stocks:{code}` 는 cache-manager에 10일 TTL로 캐싱

### Docker Compose 구성
```
postgres:5432 ← backend:3000 (api)
                 market-data:3001
                 rabbitmq:5672/15672
frontend:80 (nginx) → backend:3000, market-data:3001, ws
```
- 볼륨:
  - `postgres_data`, `rabbitmq_data`, `backend_logs`, `market_data_logs`
  - `agents_data` → `/app/.agents` (config.json + API 키 / OAuth 토큰)
  - `claude_credentials` → `/root/.claude` (Claude CLI가 읽는 `.credentials.json`)
- `market-data` 환경변수: `AGENTS_CONFIG_DIR=/app/.agents`, `CLAUDE_CONFIG_DIR=/root/.claude`,
  `CLAUDE_CLI_PATH=/usr/local/bin/claude`
- Dockerfile: `npm install -g @anthropic-ai/claude-code` + `mkdir -p /root/.claude` + `mkdir -p /app/.agents`
- 컨테이너 기동: MikroORM 마이그레이션 자동 적용 후 `node dist/main.js`
- nginx:
  - `/api/` → backend
  - `/market-api/ai-scoring/score-stream` → market-data (SSE 전용: `proxy_read_timeout 3600`, `proxy_buffering off`, `chunked_transfer_encoding off`)
  - `/market-api/` → market-data (prefix rewrite, `proxy_read_timeout 300`)
  - `/ws/` → backend WebSocket (`proxy_read_timeout 86400`)

### 인증 체계 (서비스 가드)
- **backend**: JWT + AuthGuard + RbacGuard (APP_GUARD)
- **market-data-service**: JWT AuthGuard (APP_GUARD), `@Public()` 데코레이터로 예외 처리
  - `/stocks/collection-status`: @Public (프론트엔드 상단바 폴링용)
  - `/agents/status`: @Public (Claude 설정 화면 초기 로딩용)
  - `/agents/login/status`: @Public (구독 로그인 진입 시 현재 로그인 상태 조회)

### Frontend 레이아웃
- **좌측 사이드바**: expand/collapse (`localStorage.sidebar_collapsed`), 7개 메뉴 + 관리자 메뉴
  (잔고 / 종목 조회 / 매매 / 매매 일지 / 백테스팅 / AI 종목 추천 / **Claude 설정** + 관리자: 회원 관리)
- **상단 바**: 서버 시간 (1초 갱신), `CollectionStatus` (5초 폴링), `ConnectionIndicator`, 테마 토글, 유저 메뉴
- **API 클라이언트**: 순수 fetch, JWT Bearer 자동 주입, `/api` prefix (backend), `/market-api` prefix (market-data)
- **AgentSettings 마법사**: 탭(API 키 / Claude 구독)
  - API 키 탭: 입력 → `/agents/verify` 검증 → `/agents/config` 저장
  - 구독 탭: `/agents/login`으로 URL 받기 → 새 창 열기 → 코드 붙여넣기 → `/agents/login/code`로 교환 → `/agents/config` (`authMode=subscription`) 저장

## Database (PostgreSQL)

### Backend Entities
- `User` (users) - username, email, name, password, role
- `UserAuthToken` (user_auth_tokens) - refreshToken, expiresAt
- `TradeHistory` (trade_histories) - 매매 기록
- `TradeDailySummary` (trade_daily_summaries) - 일별 매매 요약
- `AutoTradingSession` (auto_trading_sessions) - 자동매매 세션

### Market Data Entities
- `Stock` (stocks) - code, name, sector, currency, exchange
- `StockDailyPrice` (stock_daily_prices) - date, OHLCV, adjClose
- `StockCollectionSavepoint` (stock_collection_savepoints) - lastCollectedDate

## Dev Commands

```bash
pnpm dev                    # 전체 (backend + market-data + frontend 병렬)
pnpm dev:backend            # backend만 (:3000)
pnpm dev:market-data        # market-data-service만 (:3001)
pnpm dev:frontend           # frontend만 (:5173 vite dev)
pnpm build                  # 전체 빌드

docker compose up -d        # 전체 Docker 실행
docker compose up -d --build # 재빌드 후 실행
```

## Environment Variables

### backend/.env
```
DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_DATABASE
JWT_SECRET, JWT_EXPIRES_IN
KIS_ENV (sandbox|production), KIS_APP_KEY, KIS_APP_SECRET, KIS_ACCOUNT_NO, KIS_ACCOUNT_PROD_CD
```

### market-data-service/.env
```
NODE_ENV, PORT (3001), HOST
DB_HOST, DB_PORT, DB_USERNAME, DB_PASSWORD, DB_DATABASE
JWT_SECRET
RMQ_URL
CLAUDE_CLI_PATH        # Docker: /usr/local/bin/claude / 로컬: nvm 경로
AGENTS_CONFIG_DIR      # Docker: /app/.agents (config.json 저장 위치)
CLAUDE_CONFIG_DIR      # Docker: /root/.claude (.credentials.json 저장 위치 — OAuth 구독 모드)
ANTHROPIC_API_KEY      # (선택) API 키 모드에서 config.json 대신 환경변수로도 주입 가능
```

> `ANTHROPIC_AUTH_TOKEN`은 **사용하지 않습니다**. 구독 모드의 OAuth 토큰은 `~/.claude/.credentials.json`
> 파일을 통해서만 Claude CLI에 전달됩니다. (환경변수로 넘기면 API가 거부합니다.)
