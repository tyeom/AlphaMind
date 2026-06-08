# Sprint 1 구현 명세서 (Codex 실행용)

> 목적: 단타(1~3일 스윙) 다종목 자동매매의 **저위험·즉효** 개선 4건을 Codex가 곧바로 구현하도록 정밀 명세.
> 근거 리서치: `doc/short-swing-multistock-research-and-plan.md` (적대적 3표 검증 25건 통과).
> 작성 기준 코드: 2026-06-08 master.

---

## 0. Codex 작업 지침 (먼저 읽을 것)

- **레포 구조**: pnpm workspace. 앱 `apps/backend`(:3000, KIS·자동매매), `apps/market-data-service`(:3001, 스캔·백테스트), 공용 라이브러리 `libs/strategies`(`@alpha-mind/strategies`), `libs/common`.
- **스택**: NestJS 11, MikroORM 6(PostgreSQL), `@nestjs/axios`(HttpService), Jest.
- **중요 빌드 의존성**: `libs/strategies`는 **dist로 소비**된다. 이 라이브러리를 수정하면 반드시 `pnpm --filter @alpha-mind/strategies run build` 후 앱을 빌드/테스트할 것. (T4가 해당)
- **검증 명령** (각 작업 후):
  - lint: `pnpm --filter @alpha-mind/backend run lint` / `... @alpha-mind/market-data-service run lint`
  - build: `pnpm --filter @alpha-mind/strategies run build && pnpm -r run build`
  - test: `pnpm --filter @alpha-mind/backend run test` / `... @alpha-mind/market-data-service run test`
- **가드레일**:
  1. 기존 public 메서드 시그니처/엔티티 컬럼을 깨지 말 것(마이그레이션 없는 컬럼 추가 금지).
  2. 새 동작은 전부 **config/상수로 토글·튜닝 가능**하게. 하드코딩 매직넘버 금지.
  3. **검증 룰(백테스트)과 실전 룰(세션)이 어긋나지 않게** 유지 — 이 프로젝트의 핵심 불변식.
  4. 각 작업마다 **단위 테스트 추가**(아래 각 T의 테스트 섹션).
  5. 로그는 기존 `Logger` 패턴(한국어 메시지)을 따를 것.
- **작업 단위**: T1~T4는 서로 독립. 권장 순서 T3 → T1 → T2 → T4 (위험도 낮은 순). 각 작업을 개별 커밋으로.

---

## T1. 중앙 레이트리미터 + EGW00201 백오프 재시도 (P1-1) 🔴최우선

### 목표·근거
KIS OpenAPI는 **초당 거래건수 제한**이 있고 초과 시 **`EGW00201` (초당 거래건수 초과)** 를 반환한다 [검증됨 3-0]. 실무 통설은 **REST ~20 req/s** [검증됨 3-0]. 현재는 종목별로 독립 타이머가 KIS REST를 호출해(아래) 종목 수가 늘면 버스트로 한도를 초과할 수 있다. **모든 KIS REST 호출을 단일 토큰버킷으로 직렬화**하고, `EGW00201` 수신 시 지수 백오프 재시도한다.

### 현재 코드 (호출 지점)
모든 KIS REST는 `HttpService`(axios)로 직접 호출하며 공용 `KisService`(`baseUrl`, `getAuthHeaders`, `getHashkey`)를 쓴다.
- `apps/backend/src/kis/kis.service.ts`: `oauth2/tokenP`(L60), `uapi/hashkey`(L89), `oauth2/revokeP`(L105)
- `apps/backend/src/kis/kis-order.service.ts`: `order-cash`(L75), `order-rvsecncl`(정정 L259, 취소 L326). 응답 `data.rt_cd`/`data.msg1` 사용.
- `apps/backend/src/kis/kis-quotation.service.ts`: `inquire-price`(L19, getCurrentPrice), `inquire-daily-price`(L43, getDailyPrice)
- `apps/backend/src/kis/kis-inquiry.service.ts`: 잔고/체결 조회 (httpService.get 다수)
- 폴링 팬아웃: `apps/backend/src/auto-trading/auto-trading.service.ts` `startPricePolling`(L2156) — **종목당 `setInterval(5s)`**(`PRICE_POLL_INTERVAL_MS`, L97)를 만들어 `getCurrentPrice` 호출 → N종목 = N개 독립 타이머(버스트 원인).

### 구현 요구사항
1. **신규 `KisRateLimiterService`** — `apps/backend/src/kis/kis-rate-limiter.service.ts`
   - 토큰버킷: 기본 `KIS_MAX_RPS`(default **8**, 한도 20의 ~40% 보수) 만큼 초당 토큰 충전, `async acquire(): Promise<void>` 가 토큰 없으면 대기.
   - 동시성 안전(단일 프로세스 내 직렬 큐). 외부 라이브러리 없이 구현(setTimeout 기반) 권장.
   - 설정값은 `ConfigService`에서 읽기(`KIS_MAX_RPS`, `KIS_RATE_BURST` 등).
2. **공용 실행 래퍼** — `KisService`에 `async request<T>(fn: () => Promise<T>, opts?: { retryOnRateLimit?: boolean }): Promise<T>` 추가:
   - `await this.rateLimiter.acquire()` 후 `fn()` 실행.
   - 결과/예외가 **`EGW00201`**(KIS rt_cd 또는 msg, 또는 HTTP 429/5xx로 래핑된 경우)면 **지수 백오프**(base 200ms, ×2, 최대 5회, 지터)로 재시도.
   - 한도 외 에러는 그대로 throw. 재시도 소진 시 마지막 에러 throw + `Logger.warn`.
3. **호출부 마이그레이션** — 위 모든 REST 호출을 `kisService.request(() => firstValueFrom(this.httpService.<...>))` 로 감싼다. (토큰 발급/hashkey 포함. 단 토큰 발급 자체는 빈도 낮으므로 최소 acquire만.)
4. **폴링 팬아웃 정리(권장, 같은 PR 가능)**: 종목별 `setInterval` → **단일 라운드로빈 배치 폴러**로 교체. 보유/구독폴백 종목 집합을 1초 주기로 순회하며 배치 처리(리서치의 DynamicBatchCalculator 패턴: 종목수 기반 batch/지연). 최소안으로는 레이트리미터만으로도 EGW00201은 방지되므로, 팬아웃 정리는 후속 PR로 분리 가능 — **분리 시 본 명세 T1의 1~3만 필수**.

### config 추가
- `apps/backend/src/config/validation.schema.ts`: `KIS_MAX_RPS: Joi.number().default(8)`, `KIS_RATE_BURST: Joi.number().default(8)`, `KIS_RATE_MAX_RETRY: Joi.number().default(5)`.
- `apps/backend/.env.example`에 동일 키 주석과 함께 추가.
- `apps/backend/src/kis/kis.module.ts` providers/exports에 `KisRateLimiterService` 등록.

### 엣지케이스
- 토큰 발급(`getAccessToken`)은 재시도 루프 내부에서 무한루프 되지 않게(토큰 갱신과 레이트리밋 재시도 분리).
- 프로세스 종료 시 대기 중 acquire가 hang 되지 않도록(타이머 정리).
- WebSocket 경로는 REST가 아니므로 레이트리미터 대상 아님(구독 한도는 별도, 본 작업 범위 밖).

### 수용 기준
- [ ] 15개 보유 + 폴백 폴링 동시 운용 시에도 KIS REST 호출이 `KIS_MAX_RPS` 이하로 직렬화됨(테스트로 검증).
- [ ] `EGW00201` 모킹 시 백오프 재시도 후 성공/최종실패 경로 동작.
- [ ] 기존 주문/조회 동작 회귀 없음.

### 테스트
- `kis-rate-limiter.service.spec.ts`: N개 동시 `acquire()` 호출이 rps 한도 내 시간에 분산되는지(가짜 타이머 jest.useFakeTimers).
- `kis.service.request` 재시도: `fn`이 처음 2회 EGW00201 → 3회째 성공 시 1회 반환, 호출횟수 3.

---

## T2. 최대보유기간을 거래일 기준으로 (P1-5) 🟢

### 목표·근거
현재 최대보유 청산이 **달력일** 기준이라 금요일 진입분이 주말 포함으로 조기 청산된다. **거래일(영업일) 기준**으로 바꾼다.

### 현재 코드
`apps/backend/src/auto-trading/auto-trading.service.ts` `evaluateAndExecuteSell` (≈L2027):
```ts
if (
  maxHoldingDays > 0 &&
  session.enteredAt &&
  Date.now() - session.enteredAt.getTime() >= maxHoldingDays * 24 * 60 * 60 * 1000
) {
  await this.executeSell(session, price, `최대 보유기간 ${maxHoldingDays}일 도달 (...)`);
  return true;
}
```

### 구현 요구사항
1. **신규 유틸** `apps/backend/src/common/trading-calendar.ts`:
   - `tradingDaysElapsed(from: Date, to: Date, holidays?: Set<string>): number` — 주말(토·일) 제외, `holidays`(YYYY-MM-DD) 제외한 경과 거래일 수.
   - KRX 휴장일 상수 `KRX_HOLIDAYS: Set<string>`(최소 당해·익년 분, config로 확장 가능). 휴장일 미반영분은 보수적으로 +0(과청산보다 약간 보유 연장이 안전).
2. 위 조건을 `tradingDaysElapsed(session.enteredAt, new Date(), KRX_HOLIDAYS) >= maxHoldingDays` 로 교체.
3. (정밀 옵션, 주석으로 명시) 더 정확히는 `kisQuotationService.getDailyPrice(code,'D')`의 거래일 날짜로 카운트 가능하나, 호출비용 때문에 Sprint1은 영업일+휴장일셋 방식 채택.

### 엣지케이스
- `enteredAt`이 미래/동일일 → 0 반환.
- 타임존: KST 기준 날짜로 계산(`Asia/Seoul`). 자정 경계에서 일관되게.

### 수용 기준
- [ ] 금요일 진입 + maxHoldingDays=2 → 토·일 미카운트, 화요일에 도달.
- [ ] 휴장일 포함 구간 카운트 제외.

### 테스트
- `trading-calendar.spec.ts`: 금→화(2영업일), 휴장일 포함 케이스, 동일일(0).

---

## T3. 매도 거래세율 config화 (P2-5) 🟢 (가장 안전, 먼저)

### 목표·근거
2025.1.1부터 KOSPI/KOSDAQ 증권거래세 **0.18% → 0.15%** [검증됨 3-0]. 코드는 `DEFAULT_SELL_TAX_PCT=0.18` 하드코딩. **config화**하고 기본값을 현행으로. (⚠️ 2026 세율은 미확정 — 기본값은 0.15로 두되 env로 즉시 교체 가능하게. 운영 전 국세청/KRX 확인.)

### 현재 코드
`apps/market-data-service/src/strategy/backtest.service.ts`:
- L67~68: `/** ... KOSPI 0.18 기준 ... */ const DEFAULT_SELL_TAX_PCT = 0.18;`
- L219: `const sellTaxRate = (config.sellTaxPct ?? DEFAULT_SELL_TAX_PCT) / 100;`
- 생성자(현재): `constructor(private readonly em: EntityManager, private readonly optimalParamsService: OptimalParamsService) {}` — ConfigService 미주입. **ConfigModule은 market-data에서 `isGlobal: true`** 이므로 바로 주입 가능.

### 구현 요구사항
1. `BacktestService` 생성자에 `private readonly configService: ConfigService` 추가.
2. `DEFAULT_SELL_TAX_PCT` 를 `this.configService.get<number>('BACKTEST_SELL_TAX_PCT', 0.15)` 로 대체(상수 제거 또는 fallback default 0.15). L219의 fallback 갱신.
3. config: `apps/market-data-service/src/config/validation.schema.ts`에 `BACKTEST_SELL_TAX_PCT: Joi.number().default(0.15)` 추가. `.env.example`에 주석(“2025 기준 0.15; 2026 적용분 확인 후 갱신”)과 함께 추가.
4. 주석의 “KOSPI 0.18 기준”을 “2025 기준 0.15(거래세0%+농특세0.15%)”로 갱신.

### 수용 기준
- [ ] env 미설정 시 0.15 적용. `BACKTEST_SELL_TAX_PCT=0.20` 설정 시 백테스트 비용에 반영.
- [ ] 기존 `config.sellTaxPct` 명시 호출 경로는 그대로 우선.

### 테스트
- `backtest.service` 기존 spec에 세율 주입 케이스 추가(ConfigService 모킹) 또는 신규 spec.

---

## T4. RVOL(상대거래량) 스크리닝 신호 (P3-1) 🟢 (libs/strategies 빌드 필요)

### 목표·근거
“거래량이 활발한” 단타 후보 선별을 위해 **상대거래량 RVOL = 당일 거래량 / 최근 N일 평균 거래량**을 도입. 하드 필터로 과락시키기보다 **랭킹 가점 + 완만한 임계**로 사용(과필터 방지).

### 현재 코드
- 매수 리스크 필터: `libs/strategies/src/utils/buy-risk-filter.ts` `evaluateLongBuyRisk` — 이미 `avgTurnover20` 계산. `LongBuyRiskProfile` 반환.
- 스캔 랭킹: `apps/market-data-service/src/strategy/backtest.service.ts` `calculateScanRankScore`(riskProfile 인자 사용) 및 `scanSingleStock`(riskProfile → ScanResult.riskProfile 매핑).
- `ScanResult.riskProfile` 타입: `apps/market-data-service/src/strategy/types/scan.types.ts`.

### 구현 요구사항
1. `buy-risk-filter.ts`:
   - `LongBuyRiskFilterOptions`에 `minRvol?: number`(default **0**=비활성), `rvolPeriod?: number`(default 20) 추가.
   - `rvol = lastVolume / avg(volume, rvolPeriod)` 계산해 `LongBuyRiskProfile.rvol`로 노출.
   - `minRvol>0` 이고 `rvol < minRvol` 이면 `reasons.push('low_rvol')`(완만 임계, 기본 비활성이라 회귀 영향 없음).
2. `calculateScanRankScore`(backtest.service.ts): `riskProfile.rvol` 가점 추가 — 예: `rvolBonus = clamp((rvol - 1) , 0, 2) * 0.5`(RVOL>1일수록 가점, 상한). 매직넘버는 파일 상단 상수로.
3. `scan.types.ts` `riskProfile`에 `rvol?: number` 추가하고 `scanSingleStock` 매핑에 포함.
4. **libs 빌드**: `pnpm --filter @alpha-mind/strategies run build` 후 market-data 빌드.

### 엣지케이스
- 평균거래량 0/결손 → rvol undefined, 가점 0, 필터 통과(데이터부족으로 과락 금지).
- 기본값(minRvol=0, 가점 상한)으로 **기존 스캔 결과가 급변하지 않도록**.

### 수용 기준
- [ ] RVOL이 ScanResult.riskProfile.rvol로 노출됨.
- [ ] 거래량 급증 종목이 동률에서 상위로 랭크.
- [ ] minRvol 기본 0에서 기존 통과 종목 수 회귀 없음.

### 테스트
- `buy-risk-filter` spec(신규/보강): rvol 계산, minRvol 임계 동작, 결손 처리.

---

## 5. 작업 범위 밖 (이번 Sprint 제외)
- 부분 청산(scale-out), 시장 레짐 스케일러, 상관/클러스터 캡, 생존편향 보정, 롤링 walk-forward, VI/NXT 분기 주문처리 → Sprint 2~4 (상세는 `short-swing-multistock-research-and-plan.md` §3~4).

## 6. 완료 정의 (DoD)
- [ ] T1~T4 각 수용 기준 충족 + 단위 테스트 통과.
- [ ] `pnpm --filter @alpha-mind/strategies run build && pnpm -r run build` 성공.
- [ ] `pnpm -r run lint` 통과.
- [ ] 각 작업 개별 커밋(메시지에 T번호·요약).
- [ ] `.env.example`/validation.schema 동기화.
