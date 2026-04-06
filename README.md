# Alpha Mind

> 한국 주식시장(KRX)을 대상으로 하는 **매매 전략 기반 자동매매 + AI 종목 분석 플랫폼**

Alpha Mind는 4가지 매매 전략을 조합해 실시간으로 자동매매를 실행하고, 3개월간의 차트 데이터로 전략별 백테스팅을 제공하며, Claude Code 기반 **멀티 에이전트 AI 시스템**을 통해 종목을 분석/추천합니다. 한국투자증권(KIS) OpenAPI를 통해 실계좌·모의투자 환경 모두에서 주문 실행이 가능합니다.

---

## 목차

- [주요 기능](#주요-기능)
- [기술 스택](#기술-스택)
- [시스템 아키텍처](#시스템-아키텍처)
- [프로젝트 구조](#프로젝트-구조)
- [사전 준비](#사전-준비)
- [실행 방법](#실행-방법)
- [배포 (Docker Compose)](#배포-docker-compose)
- [Claude Code 인증](#claude-code-인증)
- [매매 전략](#매매-전략)
- [API 엔드포인트 개요](#api-엔드포인트-개요)
- [환경 변수](#환경-변수)

---

## 주요 기능

### 1. 매매 전략 기반 자동매매
4가지 전략(일간 모멘텀 / 평균회귀 / 무한매수봇 / 캔들 패턴) 중 하나를 선택해 **세션 단위**로 자동매매를 실행합니다.
- 한국투자증권(KIS) OpenAPI 실시간 WebSocket으로 체결·가격 스트리밍
- 전략이 생성한 매수/매도 시그널에 따라 실계좌/모의계좌 주문 자동 집행
- **자동 익절 +5% / 손절 -3%** (SELL 시그널을 생성하지 않는 전략의 경우 강제 청산)
- 세션 상태(ACTIVE/PAUSED/STOPPED)를 DB에 영속 → 서버 재시작 후 자동 복원
- 프론트엔드 WebSocket으로 실시간 가격·체결 알림 스트리밍

### 2. 모든 종목 과거 3개월 차트 데이터 자동 수집
- **KRX 전 종목**의 일봉 데이터를 Yahoo Finance v8 API로 자동 수집
- **3개월 rolling window**: 3개월 이전 데이터는 자동 삭제되어 항상 최신 상태 유지
- **SavePoint 기반 이어서 수집**: 중단된 지점부터 재개 (`last_collected_date + 1일`부터 조회)
- **스케줄**:
  - `onModuleInit` 시 누락 종목/미수집 기간 감지 → 백그라운드 수집 (HTTP 서버는 즉시 기동)
  - 매 평일(월~금) **KST 17:00 자동 수집** (`@Cron`, `Asia/Seoul` 타임존)
- **수집 상태 조회**: `/stocks/collection-status` (@Public) 엔드포인트로 `{ collecting, progress:{done,total}, lastCompletedAt }` 노출 → 프론트엔드 상단바에서 5초 폴링으로 표시

### 3. 매매 전략별 백테스팅
- 저장된 3개월 차트 데이터로 **전략/변형(variant)별 시뮬레이션**
- 단일 종목 백테스트: `POST /strategies/backtest` — 거래 내역, 수익률, MDD, 승률, 평균 체결가, 수수료 반영
- **전 종목 스캔**: `POST /strategies/scan` — 모든 전략을 전 종목에 적용해 수익률 기준 Top N 추출
  - 데이터가 20일 미만인 종목은 자동 제외
  - 50개씩 배치 병렬 처리(`Promise.allSettled`)
  - 결과: `bestStrategy`, `totalReturnPct`, `winRate`, `maxDrawdownPct`, `currentSignal`, `summary`
- 자동 익절/손절 규칙을 실제 자동매매 로직과 동일하게 적용해 **백테스트와 실매매의 결과 차이 최소화**

### 4. 멀티 에이전트 AI 종목 추천
Claude Code CLI를 `child_process.spawn`으로 실행해 **3단계 멀티 에이전트 회의 시스템**을 구현합니다. Claude 공식 CLI를 통해 WebSearch·WebFetch 도구를 활용해 실제 뉴스와 시장 데이터를 가져옵니다.

| 단계 | 에이전트 | 역할 | 방식 |
|---|---|---|---|
| **Phase 1** | 뉴스 에이전트 + 차트 에이전트 | 최근 뉴스 감성 분석 + 기술적 분석 | **병렬** |
| **Phase 2** | 주식 전문가 트레이더 + 경제 전문 분석가 | 단기/중장기 관점 의견 | **병렬** |
| **Phase 3** | 투자위원회 의장 | 두 전문가 의견 종합 + 최종 점수/추천 | 직렬 |

- 각 종목마다 분석 결과는 **SSE(Server-Sent Events)** 로 실시간 스트리밍 (`/ai-scoring/score-stream`)
- 프론트엔드는 현재 단계(Phase 1/2/3) 진행 상황을 실시간 표시
- Rate limit (`"You've hit your limit"`) 감지 시 즉시 프로세스 종료 + 분석 중단
- **AI 점수 기반 자동매매 세션 일괄 시작**: AI 추천 결과에서 종목을 선택해 한 번에 자동매매 세션 배치 생성 (`startSessionsBatch`)

---

## 기술 스택

| Layer | Tech |
|---|---|
| **Monorepo** | pnpm workspace (`apps/*`, `libs/*`) |
| **Backend** | NestJS 11, MikroORM 6, PostgreSQL 17, RabbitMQ 3, JWT |
| **Market Data** | NestJS 11, Yahoo Finance v8 API, Claude Code CLI, OAuth PKCE |
| **Frontend** | React 19, React Router 7, Vite 6, 순수 CSS(라이트/다크 테마) |
| **Broker API** | 한국투자증권(KIS) OpenAPI, WebSocket 실시간 시세 |
| **Infra** | Docker Compose, nginx reverse proxy |

---

## 시스템 아키텍처

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Frontend (nginx :80)                        │
│  React + Vite SPA                                                    │
│  /api/* → backend  │  /market-api/* → market-data  │  /ws/* → WS    │
└──────────────────────────────────────────────────────────────────────┘
           │                        │                     │
           ▼                        ▼                     ▼
┌─────────────────┐   ┌────────────────────────┐   ┌────────────────┐
│  Backend :3000  │   │  Market Data :3001     │   │  KIS WebSocket │
│  ─────────────  │   │  ─────────────────     │   │  (시세/체결)   │
│  • JWT 인증      │   │  • 차트 데이터 수집     │   └────────────────┘
│  • 사용자 관리    │◀─▶│  • 전략 백테스팅        │
│  • KIS 주문 연동  │RMQ│  • AI 멀티 에이전트    │
│  • 자동매매 세션  │   │  • Claude Code CLI     │
│  • 매매 일지      │   │  • OAuth PKCE 관리      │
└─────────────────┘   └────────────────────────┘
           │                        │
           │         ┌──────────────┴─────┐
           ▼         ▼                    ▼
    ┌──────────┐  ┌──────────┐   ┌────────────────┐
    │ Postgres │  │ RabbitMQ │   │ Yahoo Finance  │
    │  :5432   │  │  :5672   │   │   (external)   │
    └──────────┘  └──────────┘   └────────────────┘
```

- **Backend**와 **Market Data**는 HTTP + RabbitMQ 메시지 패턴 양방향 통신
- **Market Data**는 Yahoo Finance 차트 수집 + Claude Code CLI 기반 AI 분석을 담당 (backend를 느리게 만드는 무거운 I/O를 분리)
- **Frontend**는 nginx reverse proxy로 두 서비스를 하나의 오리진에서 서비스 (`/api`, `/market-api`, `/ws`)

---

## 프로젝트 구조

```
alpha-mind/
├── docker-compose.yml          # postgres, rabbitmq, backend, market-data, frontend
├── package.json                # 루트 scripts (dev, build, lint, format)
├── pnpm-workspace.yaml         # apps/*, libs/*
│
├── apps/
│   ├── backend/                # :3000 (api prefix: /api)
│   │   └── src/
│   │       ├── auth/           # JWT 인증 (sign-in/up, refresh)
│   │       ├── user/           # 사용자 CRUD + 관리자 기능
│   │       ├── kis/            # 한국투자증권 OpenAPI 연동
│   │       │                   # (주문/잔고/시세/일봉/매매일지 + KIS WebSocket)
│   │       ├── auto-trading/   # 자동매매 세션 관리 + 프론트 WS 게이트웨이
│   │       ├── rmq/            # RabbitMQ 연결 (market_data_queue)
│   │       └── health/         # /api/health (Terminus)
│   │
│   ├── market-data-service/    # :3001
│   │   ├── data/
│   │   │   ├── krx_codes.csv   # KRX 전 종목 코드 목록
│   │   │   └── rx_sector_map.csv
│   │   └── src/
│   │       ├── stock/          # 차트 데이터 수집/관리 (SavePoint, Cron)
│   │       ├── yahoo-finance/  # Yahoo Finance v8 API 클라이언트
│   │       ├── strategy/       # 전략 실행 + 백테스트 + 전 종목 스캐너
│   │       ├── ai-scoring/     # 3단계 멀티 에이전트 (Phase1/2/3)
│   │       │   └── claude-pty.ts  # Claude Code CLI spawn 래퍼
│   │       └── agent-config/   # Claude 인증 설정 (API 키 + OAuth PKCE)
│   │
│   └── frontend/               # :80 (nginx) / :5173 (vite dev)
│       └── src/
│           ├── components/     # Layout, CollectionStatus, ConnectionIndicator
│           ├── contexts/       # AuthContext, ThemeContext
│           ├── hooks/          # useKisWebSocket, useAutoTradingWebSocket
│           ├── api/            # fetch 기반 HTTP 클라이언트 (JWT 자동 주입)
│           └── pages/
│               ├── trading/    # 잔고 / 종목 조회 / 매매 / 매매 일지
│               ├── Backtest.tsx
│               ├── AiScanner.tsx       # AI 종목 추천 (SSE)
│               ├── AgentSettings.tsx   # Claude Code 인증 마법사
│               └── admin/              # 회원 관리 (관리자 전용)
│
├── libs/
│   ├── common/                 # @alpha-mind/common
│   │   # AuthGuard, RbacGuard, @Public, @Roles, UserRole, AllExceptionFilter
│   │
│   └── strategies/             # @alpha-mind/strategies
│       # 독립 라이브러리 — backend/market-data 양쪽에서 import
│       ├── indicators/         # SMA, RSI, Bollinger, ATR 등
│       └── strategies/         # day-trading, mean-reversion, infinity-bot, candle-pattern
│
└── .agents/                    # Claude 인증 (gitignored, Docker 볼륨)
    └── config.json             # { authMode, anthropicApiKey / oauth* }
```

### 설계 원칙

- **Monorepo + 서비스 분리**: `backend`(트레이딩 실행)와 `market-data-service`(데이터 수집/분석)를 분리해 무거운 I/O 부하가 실매매 주문 실행에 영향을 주지 않도록 분리
- **libs 공유**: 매매 전략 로직(`libs/strategies`)은 **백테스트**(market-data)와 **실매매**(backend)에서 동일하게 재사용 → 백테스트 결과와 실매매 결과의 로직 일관성 보장
- **공통 인증 가드**: `libs/common`의 `AuthGuard`/`RbacGuard`를 두 서비스에서 공유, `@Public()` 데코레이터로 예외 경로 선언
- **3개월 rolling window**: 저장 공간 최적화 + 오래된 데이터로 인한 전략 왜곡 방지
- **SSE 기반 진행 상황 스트리밍**: AI 분석은 분당 단위 소요 → 단계별(Phase 1/2/3) 진행을 실시간 표시
- **OAuth PKCE 직접 구현**: Claude CLI의 `claude login` 서브프로세스를 띄우지 않고, 서버가 PKCE 플로우를 직접 수행 → 웹 UI에서 매끄러운 인증 경험 제공

---

## 사전 준비

1. **Node.js 22+** (권장: nvm 사용)
2. **pnpm 9+** (`corepack enable` 후 `corepack prepare pnpm@latest --activate`)
3. **Docker + Docker Compose** (배포 및 로컬 통합 실행용)
4. **한국투자증권 OpenAPI 발급**: [KIS Developers](https://apiportal.koreainvestment.com/)에서 `APP KEY`, `APP SECRET`, 계좌번호 발급
5. **Claude 인증 수단** (둘 중 하나):
   - **API 키**: [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)에서 발급
   - **Claude 구독 계정**: Claude Pro / Max / Team / Enterprise

---

## 실행 방법

### 1) 저장소 클론 & 의존성 설치

```bash
git clone <repo-url> alpha-mind
cd alpha-mind
pnpm install
```

### 2) 환경 변수 설정

```bash
cp apps/backend/.env.example apps/backend/.env
cp apps/market-data-service/.env.example apps/market-data-service/.env
# 두 파일을 열어 DB, JWT_SECRET, KIS_* 값 등을 채워 넣는다.
```

### 3) PostgreSQL + RabbitMQ만 Docker로 띄우기

```bash
docker compose up -d postgres rabbitmq
```

### 4) 로컬 개발 서버 실행

```bash
# 전체 병렬 실행 (backend + market-data + frontend)
pnpm dev

# 개별 실행
pnpm dev:backend         # http://localhost:3000
pnpm dev:market-data     # http://localhost:3001
pnpm dev:frontend        # http://localhost:5173 (Vite dev proxy → :3000, :3001)
```

### 5) 빌드

```bash
pnpm build                 # 전체 빌드
pnpm build:backend
pnpm build:market-data
pnpm build:frontend
```

### 6) Lint / Format

```bash
pnpm lint
pnpm format
```

---

## 배포 (Docker Compose)

### 전체 스택 실행

```bash
# 최초 빌드 및 실행
docker compose up -d --build

# 이후 재시작
docker compose up -d

# 로그 확인
docker compose logs -f backend
docker compose logs -f market-data
docker compose logs -f frontend

# 중지
docker compose down
```

### 포트 매핑

| 서비스 | 포트 | 설명 |
|---|---|---|
| **frontend** (nginx) | `80` | 메인 접근 URL — `http://localhost` |
| **backend** | `3000` | REST API (`/api`), WebSocket (`/ws`) |
| **market-data** | `3001` | 차트 수집 / 백테스트 / AI 분석 |
| **postgres** | `5432` | PostgreSQL 17 |
| **rabbitmq** | `5672`, `15672` | AMQP + 관리 콘솔 |

### Docker 볼륨

| 볼륨 | 마운트 위치 | 용도 |
|---|---|---|
| `postgres_data` | `/var/lib/postgresql/data` | DB 데이터 |
| `rabbitmq_data` | `/var/lib/rabbitmq` | RabbitMQ 상태 |
| `backend_logs` | `/app/apps/backend/logs` | Backend 로그 |
| `market_data_logs` | `/app/apps/market-data-service/logs` | Market Data 로그 |
| `agents_data` | `/app/.agents` | Claude 인증 config.json |
| `claude_credentials` | `/root/.claude` | Claude CLI `.credentials.json` (OAuth) |

### nginx 라우팅

- `/api/*` → `backend:3000`
- `/market-api/ai-scoring/score-stream` → `market-data:3001` (SSE 전용: `proxy_read_timeout 3600`, `proxy_buffering off`, `chunked_transfer_encoding off`)
- `/market-api/*` → `market-data:3001` (prefix rewrite, `proxy_read_timeout 300`)
- `/ws/*` → `backend:3000` (WebSocket, `proxy_read_timeout 86400`)

### DB 마이그레이션

Market Data 컨테이너는 기동 시 MikroORM 마이그레이션을 자동 적용한 뒤 서버를 시작합니다:

```sh
node -e "... MikroORM.init ... getMigrator().up() ..." && node dist/main.js
```

---

## Claude Code 인증

AI 종목 분석에는 Anthropic Claude(Sonnet)가 필요합니다. Alpha Mind는 **두 가지 인증 방식**을 지원하며, 프론트엔드 **Claude 설정 페이지**(`/agent-settings`)에서 마법사 UI를 통해 손쉽게 전환할 수 있습니다.

### 방식 1: Anthropic API 키

1. [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys)에서 API 키 발급
2. **좌측 사이드바 → Claude 설정 → "Anthropic API 키" 탭** 선택
3. API 키 입력 → **"키 검증"** 버튼 → **"저장"**
4. 서버가 실제로 `https://api.anthropic.com/v1/messages`에 테스트 호출을 보내 401이 아니면 유효로 판정
5. 저장된 키는 `.agents/config.json`에 `{ "authMode": "api_key", "anthropicApiKey": "sk-ant-..." }` 형태로 저장되며, Claude Code CLI 실행 시 `ANTHROPIC_API_KEY` 환경변수로 주입됩니다

### 방식 2: Claude 구독 계정 (OAuth PKCE) ★ 권장

Claude Pro / Max / Team / Enterprise 구독 계정을 가지고 있다면, **별도 API 비용 없이** 구독 쿼터로 AI 분석을 사용할 수 있습니다. Alpha Mind는 웹 UI 내에서 PKCE OAuth 플로우를 제공해 `claude login` CLI를 수동으로 실행할 필요가 없습니다.

#### 간편 인증 절차 (4단계)

```
┌────────────────────────────────────────────────────────────┐
│ 1. "Claude 로그인" 버튼 클릭                                │
│    → 서버가 PKCE code_verifier/challenge/state 생성         │
│    → https://claude.ai/oauth/authorize?... URL 반환         │
│    → 브라우저 새 창으로 자동 오픈                            │
└────────────────────────────────────────────────────────────┘
                            ▼
┌────────────────────────────────────────────────────────────┐
│ 2. Claude 로그인 페이지에서 본인 계정으로 로그인 + 권한 승인  │
└────────────────────────────────────────────────────────────┘
                            ▼
┌────────────────────────────────────────────────────────────┐
│ 3. 콜백 페이지에 표시된 authorization code를 복사             │
│    → Alpha Mind 설정 페이지의 입력 창에 붙여넣기              │
│    → "인증 코드 제출" 버튼                                   │
└────────────────────────────────────────────────────────────┘
                            ▼
┌────────────────────────────────────────────────────────────┐
│ 4. 서버가 code → token 교환                                  │
│    POST https://console.anthropic.com/v1/oauth/token        │
│    grant_type=authorization_code + PKCE verifier             │
│    → access_token + refresh_token 획득                       │
│    → .agents/config.json + ~/.claude/.credentials.json 저장   │
│    → ✓ 완료! AI 종목 추천 바로 사용 가능                      │
└────────────────────────────────────────────────────────────┘
```

#### 토큰 자동 갱신

- AI 분석 호출 직전 `ensureValidOAuthToken()` 호출
- 토큰 만료까지 **5분 미만** 남았으면 `refresh_token`으로 자동 갱신
- 갱신된 토큰은 `.agents/config.json`과 `~/.claude/.credentials.json` 양쪽에 저장
- 재로그인 없이 장기 세션 유지

#### 내부 동작 상세

- **Token URL**: `https://console.anthropic.com/v1/oauth/token`
- **Authorize URL**: `https://claude.ai/oauth/authorize`
- **Client ID**: `9d1c250a-e61b-44d9-88ed-5944d1962f5e` (Claude Code 공식 CLI와 동일)
- **Scopes**: `org:create_api_key`, `user:profile`, `user:inference`, `user:sessions:claude_code`, `user:mcp_servers`, `user:file_upload`
- **Credentials 파일**: Claude CLI가 `~/.claude/.credentials.json`의 `claudeAiOauth` 블록을 읽어 실제 호출에 사용 (파일 모드 `0o600`)
- **중요 제약**: `ANTHROPIC_AUTH_TOKEN` 환경변수로 OAuth 토큰을 직접 전달하면 API가 거부하므로 **절대 사용하지 않습니다**. 파일 기반 전달만 사용.

### 인증 상태 확인

- 사이드바 → **Claude 설정** 페이지에서 현재 인증 상태(`api_key` / `subscription` / `미설정`)와 키 미리보기 확인 가능
- API 엔드포인트:
  - `GET /agents/status` (@Public) — 현재 인증 모드/상태
  - `GET /agents/login/status` (@Public) — 구독 모드 로그인 여부

---

## 매매 전략

`libs/strategies`에는 4가지 전략이 구현되어 있으며, 각 전략은 여러 **variant**를 가집니다. 모든 전략은 동일한 `(candles, config) → StrategyAnalysisResult` 인터페이스를 준수해 **백테스트와 실매매에서 동일 로직**이 사용됩니다.

| 전략 ID | 이름 | Variants |
|---|---|---|
| `day-trading` | 일간 모멘텀 통합 전략 | `breakout` (래리 윌리엄스 변동성 돌파), `crossover` (이동평균 교차), `volume_surge` (거래량 급증) |
| `mean-reversion` | 평균회귀 전략 | `rsi`, `bollinger`, `grid`, `magic_split` (마법의 분할매수) |
| `infinity-bot` | 무한매수봇 | 분할매수 + 장기 홀딩 |
| `candle-pattern` | 캔들 패턴 인식 | 18종 패턴 (망치형, 샛별, 장악형 등) |

**공통 자동 익절/손절** (SELL 시그널을 생성하지 않는 전략은 시뮬레이션/실매매 양쪽에서 적용):
- 익절: `+5%`
- 손절: `-3%`

---

## API 엔드포인트 개요

### Backend (`:3000`, prefix `/api`)

| Method | Path | 설명 |
|---|---|---|
| `POST` | `/api/auth/sign-up` | 회원가입 |
| `POST` | `/api/auth/sign-in` | 로그인 (JWT 발급) |
| `POST` | `/api/auth/refresh` | 리프레시 토큰 |
| `GET` | `/api/users/me` | 내 정보 |
| `PATCH` | `/api/users/me` | 내 정보 수정 |
| `GET` | `/api/users` | 사용자 목록 (관리자) |
| `PATCH` | `/api/users/:id` | 사용자 수정 (관리자) |
| `POST` | `/api/kis/orders` | KIS 매수/매도 주문 |
| `GET` | `/api/kis/balance` | KIS 잔고 조회 |
| `GET` | `/api/kis/quote/:code` | KIS 시세 조회 |
| `GET` | `/api/kis/journal` | 매매 일지 |
| `POST` | `/api/auto-trading/sessions` | 자동매매 세션 시작 |
| `POST` | `/api/auto-trading/sessions/batch` | 복수 세션 일괄 시작 |
| `GET` | `/api/auto-trading/sessions` | 세션 목록 |
| `PATCH` | `/api/auto-trading/sessions/:id/pause` | 일시정지 |
| `PATCH` | `/api/auto-trading/sessions/:id/resume` | 재개 |
| `DELETE` | `/api/auto-trading/sessions/:id` | 종료 |
| `GET` | `/api/health` | 헬스체크 (Terminus) |
| WS | `/ws/kis` | KIS 실시간 시세 |
| WS | `/ws/auto-trading` | 자동매매 실시간 가격/체결 |

### Market Data (`:3001`, nginx 경로 `/market-api`)

| Method | Path | 설명 |
|---|---|---|
| `GET` | `/stocks` | 전 종목 목록 (10일 캐시) |
| `GET` | `/stocks/:code` | 종목 상세 |
| `GET` | `/stocks/:code/prices?limit=30` | 일봉 데이터 |
| `GET` | `/stocks/collection-status` | 수집 상태 (@Public) |
| `POST` | `/stocks/collect` | 수동 수집 트리거 |
| `POST` | `/strategies/backtest` | 단일 종목 백테스트 |
| `POST` | `/strategies/scan` | 전 종목 전략 스캔 (Top N) |
| `POST` | `/ai-scoring/score-stream` | **AI 종목 분석 (SSE)** |
| `POST` | `/ai-scoring/score` | AI 분석 (동기) |
| `GET` | `/agents/status` | 인증 상태 (@Public) |
| `POST` | `/agents/config` | 인증 설정 저장 |
| `POST` | `/agents/verify` | API 키 검증 |
| `POST` | `/agents/login` | OAuth PKCE URL 생성 |
| `POST` | `/agents/login/code` | Authorization code → 토큰 교환 |
| `GET` | `/agents/login/status` | 구독 로그인 상태 (@Public) |

---

## 환경 변수

### `apps/backend/.env`

```env
NODE_ENV=development
PORT=3000
HOST=0.0.0.0

# Database
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=alpha
DB_PASSWORD=alpha1234
DB_DATABASE=alpha_mind

# JWT
JWT_SECRET=your-jwt-secret-key
JWT_EXPIRES_IN=1d

# KIS (한국투자증권) — sandbox: 모의투자, production: 실전투자
KIS_ENV=sandbox
KIS_APP_KEY=your-kis-app-key
KIS_APP_SECRET=your-kis-app-secret
KIS_ACCOUNT_NO=12345678
KIS_ACCOUNT_PROD_CD=01

# RabbitMQ (Docker 시: amqp://alpha:alpha1234@rabbitmq:5672)
RMQ_URL=amqp://alpha:alpha1234@localhost:5672
```

### `apps/market-data-service/.env`

```env
NODE_ENV=development
PORT=3001
HOST=0.0.0.0

# Database
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=alpha
DB_PASSWORD=alpha1234
DB_DATABASE=alpha_mind

# JWT (backend와 동일한 값)
JWT_SECRET=your-jwt-secret-key

# RabbitMQ
RMQ_URL=amqp://alpha:alpha1234@localhost:5672

# Claude Code CLI
CLAUDE_CLI_PATH=/usr/local/bin/claude        # Docker 내부
# CLAUDE_CLI_PATH=/Users/you/.nvm/versions/node/v22/bin/claude   # 로컬 개발 시

AGENTS_CONFIG_DIR=/app/.agents               # config.json 저장 위치
CLAUDE_CONFIG_DIR=/root/.claude              # .credentials.json 저장 위치

# (선택) API 키 모드에서 config.json 대신 환경변수로도 주입 가능
# ANTHROPIC_API_KEY=sk-ant-...
```

> ⚠️ **`ANTHROPIC_AUTH_TOKEN`은 사용하지 않습니다.** 구독 모드의 OAuth 토큰은 `~/.claude/.credentials.json` 파일을 통해서만 Claude CLI에 전달됩니다. (환경변수로 넘기면 API가 거부합니다.)

---

## 라이선스

MIT License
