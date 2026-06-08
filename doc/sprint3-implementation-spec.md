# Sprint 3 구현 명세서 (Codex 실행용)

> 목적: 단타(1~3일 스윙) 다종목 자동매매에 **(A) 시장 레짐 스케일러** 와 **(B) 상관/클러스터 캡** 2건을 Codex가 곧바로 구현하도록 정밀 명세.
> 합성 근거: 설계 3안(정확성·엣지케이스)을 베이스로, 설계 1안(MVP·롤백 1토글·신규데이터 0)과 설계 2안(정량 오프라인 시뮬 검증)을 그래프트. 적대적 리뷰의 **critical 3 / high 4 / medium 4 / low 2 전부 반영**.
> 작성 기준 코드: 2026-06-08 master. 모든 라인 인용은 실제 파일 Read/Grep 확인 결과.
> 산출 구조는 `doc/sprint2-implementation-spec.md` 와 동일(작업별: 목표·근거 / 현재코드 / 데이터모델 / 알고리즘 / config / 엣지케이스 / 수용기준 / 테스트 / 검증방법).
> **핵심 결정**: 레짐 데이터 출처 = **유니버스 브레드스 프록시(신규 데이터 0)**. 두 기능 모두 config 기본 OFF. 롤백은 토글 1개씩.

---

## 0. Codex 작업 지침 (먼저 읽을 것)

- **레포 구조**: pnpm workspace. `apps/backend`(:3000, KIS·자동매매), `apps/market-data-service`(:3001, 스캔·백테스트), 공용 라이브러리 `libs/strategies`(`@alpha-mind/strategies`), `libs/common`.
- **스택**: NestJS 11, MikroORM 6(PostgreSQL), `@nestjs/microservices`(RMQ), Jest.
- **🔴 중요 빌드 의존성**: `libs/strategies` 는 **dist 로 소비**된다. 신규 유틸(`market-regime.ts`, `correlation-cluster.ts`) 추가/수정 후 반드시 `pnpm --filter @alpha-mind/strategies run build` 를 **먼저** 실행하고 앱을 빌드/테스트할 것. 빌드 누락 시 런타임에 함수 미존재 → `scanAllStocks` import throw → 스캔 전면 실패. (Sprint2와 동일 함정. 본 스프린트는 추가로 `scanAllStocks` 전체를 try/catch 로 감싸 레짐/클러스터 부재 시 레거시 폴백한다 — 아래 가드레일.)
- **검증 명령**(각 작업 후):
  - build: `pnpm --filter @alpha-mind/strategies run build && pnpm -r run build`
  - lint: `pnpm --filter @alpha-mind/backend run lint` / `pnpm --filter @alpha-mind/market-data-service run lint`
  - test: `pnpm --filter @alpha-mind/backend run test` / `pnpm --filter @alpha-mind/market-data-service run test`
- **가드레일**:
  1. 기존 public 메서드 시그니처/타입/컬럼 **비파괴**. 신규 필드는 전부 **optional**. 신규 동작은 전부 **config 토글·튜닝**, 하드코딩 매직넘버 금지. 기본값 = 기존 동작(`REGIME_SCALING_ENABLED=false`, `CORRELATION_CAP_ENABLED=false`).
  2. **검증 룰(백테스트)과 실전 룰(scan/session) 정합** — 이 프로젝트의 핵심 불변식. 단, 레짐 스케일·상관캡은 **포트폴리오 구성 레이어**라 종목 단위 `runBacktest` 로는 검증 불가(Sprint2 부분청산/R사이징과 동일 한계). 상관·레짐 계산식은 **순수 함수 1세트**(`libs/strategies`)로 단일화해 market-data가 단일 책임으로 계산하고, backend는 게이트/적용만 한다.
  3. **DB 마이그레이션 없음**: 레짐 히스테리시스 상태는 `OptimalParamsService` 와 동일한 **JSON 파일 영속화**(`data/market_regime_state.json`)로 둔다(마이그레이션·신규 엔티티 회피, Sprint3 인프라 최소화). 컬럼 추가가 0이므로 `[OptionalProps]` 갱신도 없음.
  4. 각 작업마다 **단위 테스트 추가**. 토글 OFF 회귀 골든테스트 + 오프라인 스냅샷 시뮬을 **수용기준 필수**로 포함.
  5. 로그는 기존 `Logger` 패턴(한국어 메시지)을 따른다.
- **Fail-safe 원칙(전 경로)**: 신규 유틸(`computeMarketRegime`/`clusterByCorrelation`) 호출은 전부 try/catch. 예외/누락/표본부족 시 **레짐=NEUTRAL(스케일 1.0)·클러스터 미부여(캡 미적용)** 로 폴백 → 기존 분산필터(`scheduled-scanner` L426-442)·역가중(L608-639) 경로가 그대로 동작. 신규 코드 장애가 스캔/매매를 멈추면 안 된다.
- **권장 순서**: (1) `libs/strategies` 유틸 2종(`market-regime.ts`, `correlation-cluster.ts`) + 순수함수 단위테스트 → **build** → (2) `scan.types.ts` 옵셔널 필드(`regime`/`clusterId`/`clusters`) + backend 미러 타입 → (3) market-data `scanAllStocks` 브레드스 경량패스·상관·`correlationCodes` 옵션 → (4) backend `applyScanResults` 스케일·클러스터 게이트(try/catch 폴백) → (5) 레짐 상태 JSON 영속화(히스테리시스) → (6) 오프라인 시뮬 스크립트 + 골든 회귀테스트. 각 작업 개별 커밋.

- **합성 핵심 결정**(리뷰 recommendedApproach 채택 — 반드시 준수):
  1. **레짐·상관 계산은 market-data(`scanAllStocks`)에서만**, 캡/스케일 적용은 backend(`applyScanResults`)에서. (backend는 가격 시계열이 없음 — `scheduled-scanner` 는 stocks 의 sector만 조회 L580-587.)
  2. **브레드스 집계는 `scanSingleStock` 밖, chunk 루프(L867) 내 별도 경량 패스**로. `scanSingleStock` 은 4개 게이트(L1015/L1028/L1038/L1043)에서 null 을 반환하고 SMA/ATR를 버리므로, 그 반환값에 의존하면 **생존편향**(통과종목만 집계)이 발생한다. (critical #1 — 아래 T1 알고리즘에 코드량·CPU 비용까지 명시.)
  3. **활성보유×신규후보 혼합 상관을 정면 구현**: `requestScan` RMQ payload 에 `correlationCodes=Array.from(activeCodes)` 추가 → market-data가 활성종목 close[] 별도 로드 → 후보+활성 혼합 상관 → `ScanResponse.clusters[]`(clusterId·codes)로 내려보내 backend가 활성 세션을 클러스터에 역매핑·시드. (critical #2/#3 — 설계 1·2의 '후보-후보만' 안은 폐기. 섹터캡보다 커버리지가 좁아지는 역설 방지.)
  4. **vol percentile = 고정 임계(VOL_FLOOR/CEIL) 3구간 정규화**. 설계 1의 '통과종목 ATR% 동적 백분위'는 약세장 표본편향으로 **폐기**(high #5). 표본<MIN 이면 vol 성분 중립(0.5).
  5. **플립플랍 방지 2겹**: EMA(5일) 평활 + 진입/이탈 분리 밴드 히스테리시스 + 최소유지일. 설계 1의 'data/last_regime.json 1칸이동·데드밴드 ±0.03' 단독은 억제력 부족으로 보강(high #6).
  6. **레짐=파이 크기, 역가중=파이 분배**: 레짐은 평균 base 금액만 치환, per-종목 clamp[0.5,2.0]·역가중 분배는 불변. **슬롯×금액 동시 확대 금지**(곱 상한 cap) — momentum에서 총 익스포저 폭주 방지(high #4).
  7. **노출 0 방지 하드 플로어**: CRISIS여도 `effectiveMaxHoldings≥REGIME_MIN_HOLDINGS_FLOOR(3)`·`amountMultiplier≥REGIME_AMOUNT_FLOOR(0.4)`. 축소이지 매매 중단이 아니다.
  8. **3중 캡 = 단일 채택 루프 순차 게이트**(동시보유→섹터→클러스터), 카운터는 **채택 직전 1회만** 증가 → 이중 제외 없음. `clusterId==null`(미산출/단독)은 캡 비적용(섹터 미상 정책 L412와 대칭).
  9. **클러스터 유틸은 상관만 사용**(역행렬/촐레스키 없음) → 특이행렬 throw 원천 차단. union-find 연결요소, 코드 사전순 union 으로 ID 결정성 확보. **CORR_THRESHOLD=0.8 보수 시작**(전이연쇄 완화) + 거대 클러스터 폴백 플래그(아래).
  10. **scanAllStocks 신규 인자는 위치인자 대신 options 객체**로(기존 `scaleOutOptions` 패턴과 동일) — 위치 의존성 제거(medium #9). 호출부는 정확히 2곳(controller L329, L363).

---

## T1. 시장 레짐 스케일러

### 목표·근거
시장 국면(변동성·추세)에 따라 **전체 익스포저**(동시보유 상한 `MAX_CONCURRENT_HOLDINGS=15`, 종목당 투자금 `SCAN_INVESTMENT_AMOUNT=1,000,000`)를 동적 조절. 위험 국면=축소, 안전+모멘텀=정상/확대. 근거: 검증된 변동성 타깃 사이징 — 노출 ∝ Kelly×(1−vol percentile). Kelly는 승률·손익비 추정 불안정으로 **fractional(이산 상수 곱)** 형태만 차용하고, 핵심은 vol 게이팅이다. **DB에 지수가 없으므로**(KOSPI/KOSDAQ 지수·레버리지/인버스 ETF 부재, 보유 데이터는 개별 KRX 2,886종목 약 6개월=131거래일 일봉) "시장"을 **유니버스 브레드스 프록시**로 대체한다. `momentum-power.strategy.ts` 의 '종가>장기MA=안전, >단기MA=모멘텀' 판단을 **전 종목 집계**로 끌어올린 형태(momentum-power는 분석대상 자기 candles 기반이라 전역 레짐이 아님 — 패턴만 차용).

### 현재 코드 (파일·라인)
- **익스포저 결정 지점**: `apps/backend/src/auto-trading/scheduled-scanner.service.ts`
  - 상수 L19 `SCAN_INVESTMENT_AMOUNT=1_000_000`, L20 `SCAN_TOP_N=35`, L36 `MAX_CONCURRENT_HOLDINGS=15`, L38 `MAX_PER_SECTOR=4`, L40-41 `VOL_WEIGHT_MIN/MAX=0.5/2.0`, L47 `FALLBACK_VOLATILITY_PCT=3.0`.
  - `requestScan()` L144-207: active/manual 산출 L171-181, RMQ `strategy.scan.request` emit L187-200(`excludeCodes`/`topN`/`investmentAmount` 등 — 여기에 `correlationCodes` 추가). **active 종목은 `excludeCodes`(L181, L191)로 스캔에서 빠진다 → 스캔 결과·가격에 없음**(critical #2 근거).
  - `applyScanResults()` L352-536: 매수후보 필터 L385-395 → 분산필터 L409-449(`availableSlots = max(0, MAX_CONCURRENT_HOLDINGS − activeCodes.size)` L418-421, 섹터캡 단일 루프 L426-442) → toResume/toStart L451-460 → `computeVolatilityWeightedInvestments(toStart)` L463 → startSessions L505-530.
  - `countSectors()` L566-602: 활성 세션 섹터 분포. **active 종목이 스캔결과에 없어 stocks 테이블에서 직접 조회로 보충**(L575-593) — 클러스터 시드도 동일 철학으로 설계(단, 클러스터는 가격이 필요해 보충 불가 → correlationCodes 경로로 해결).
  - `computeVolatilityWeightedInvestments()` L608-639: weight를 mean=1로 정규화(L630) 후 [VOL_WEIGHT_MIN, VOL_WEIGHT_MAX] clamp(L631-634), `amount = round(SCAN_INVESTMENT_AMOUNT * weight)`(L635). → **clamp 발동 시 실현 평균이 SCAN_INVESTMENT_AMOUNT를 이미 벗어남**(high #4 근거: 여기에 investmentScale을 곱하면 momentum에서 per-stock 최대 = scale×2.0 까지 팽창).
  - backend 측 미러 타입: `ScanResult` L49-59, `ScanResponse` L61-66, `ScanCompletedEvent` L68-72.
  - `ConfigService` 주입 L86, `configService.get<number>('SCHEDULED_TRADER_USER_ID')` L115 패턴.
- **브레드스 계산 위치**: `apps/market-data-service/src/strategy/backtest.service.ts`
  - 상수 L54 `DEFAULT_AUTO_TAKE_PROFIT_PCT=2.0`, L64 `SCAN_STOCK_CHUNK_SIZE=200`, L92 `SCAN_LOOKBACK_MONTHS=6`.
  - `scanAllStocks()` L762-919: 시그니처 마지막 인자 `scaleOutOptions: ScaleOutBacktestOptions = {}`(L773 — **신규 옵션을 여기 객체에 합류**) → eligible(≥60일) 필터 L786-798(`eligibleStocks` = 모집단) → `this.em.clear()` L817 → **chunk 가격 적재 루프 L835-901**(`pricesByStockId` Map L850-865, **L900 `pricesByStockId.clear()` 로 직전 chunk 가격 즉시 폐기** = OOM 회피) → `allResults.sort` L904 → `topResults = slice(0, topN)` L905 → `return {scannedStocks, eligibleStocks, excludedStocks, elapsedMs, results}` L912-918.
  - `scanSingleStock()` L1001-1223: **null 반환 4지점** — prices<60(L1015), candles<60(L1028), in/out-sample 표본부족(L1038), `riskProfile.passed=false`(L1043). `evaluateLongBuyRisk(candles)` 는 **L1042(L1043 게이트 직전)** 에서만 호출되어 `volatilityPct`(L1046) 산출. → 통과 못 한 종목의 SMA/ATR는 외부로 안 나옴(critical #1 근거).
  - RMQ 핸들러 `handleScanRequest()` `strategy.controller.ts` L351-417(`scanAllStocks` 호출 L363-375, `strategy.scan.completed` emit L400-408). HTTP `scanStocks()` L325-342(호출 L329). **production 호출부는 정확히 이 2곳**(+ 테스트 mock).
  - 응답 타입: `scan.types.ts` `ScanResponse` L72-78, `ScanResult` L1-70.
- **재사용 유틸**: `libs/strategies/src/indicators/technical-indicators.ts` — `calculateSMA(prices, period): (number|null)[]`(L4), `calculateATR(candles, period): (number|null)[]`(L103). `buy-risk-filter.ts` L112-115: `volatilityPct = round2((lastAtr/lastClose)*100)`(동일 식 재사용).
- **영속화 패턴**: `optimal-params.service.ts` L34-37 `path.resolve(process.cwd(), 'data/optimal_params.json')`, L66-77 readFromDisk(ENOENT→null), L79-83 writeToDisk(mkdir recursive + writeFile) — `data/market_regime_state.json` 에 동일 패턴 적용.
- 지수 부재 확인됨: regime/breadth/index 관련 코드 전무.

### 레짐 데이터 출처 (권장 + 대안 트레이드오프)
| 안 | 방식 | 신규데이터/인프라 | 정합·재현성 | 약점 | 결정 |
|---|---|---|---|---|---|
| **(a) 유니버스 브레드스 프록시** | `scanAllStocks` 가 이미 가진 2,886종목 일봉으로 ①종가>SMA20/SMA60 비율 ②유니버스 중앙 5일수익률 ③중앙 ATR% 집계 | **0**(가격 그대로, 추가 IO·네트워크 0) | **높음**: 레짐과 매수후보가 같은 데이터·같은 시점 → 검증↔실전 완전 정합. 동일 스냅샷=동일 레짐(재현) | 지수 1:1 불일치(소수 대형주 주도장에서 괴리). 131일이라 vol 표본 한정 | **채택** |
| (b) yahoo 페치(^KS11/^KQ11/069500) | `YahooFinanceService.getChart`(존재, throttle+MAX_RETRIES=3, 429 백오프) 호출 | 외부 네트워크 의존 | 중간: 가용성·rate limit(429)에 좌우. 백테스트 과거 레짐 재현 불가 | **스캔 크리티컬 패스에 외부 I/O 실패 주입 → 스캔 블로킹 위험** | enum 자리만, 미구현 |
| (c) 지수 일봉 DB 적재 | `stock.service` 수집기 확장 + 마이그레이션 | 수집기·스케줄·마이그레이션·심볼매핑 | 높음(적재 후) | **Sprint3 범위(2건) 초과** | 비채택, 사유문서화 |

→ **권장 (a) 유니버스 브레드스 프록시**. 이유: (1) 데이터정합 — 레짐과 후보가 같은 데이터·시점에서 나와 핵심 불변식 보존. (2) 신규 데이터/인프라 0 — "지수 없음" 제약을 우회. (3) 포트폴리오 관점 정확성 — 실제 운용 유니버스의 내부 위험(동반 하락·변동성 확대)을 지수보다 직접 측정.
**(b) yahoo/hybrid 처리(low #2 반영)**: `REGIME_INDEX_SOURCE` enum(`breadth`|`yahoo`|`hybrid`)과 폴백 라벨만 둔다. **실제 합성 로직은 Sprint3에서 구현하지 않는다**(죽은 코드 회피). `yahoo`/`hybrid` 값이 와도 NotImplemented→`breadth` 폴백하고 `source` 라벨을 응답·로그에 남겨 운영자가 breadth 단독임을 확인 가능하게 한다.

### 데이터 모델 (신규 필드 — 전부 optional, 컬럼 0)
`scan.types.ts` `ScanResponse` 에 optional 1필드 추가:
```ts
export type RegimeLabel = 'CRISIS' | 'NEUTRAL' | 'ATTACK';
export interface BreadthSnapshot {
  universeCount: number;       // 브레드스 집계 모집단(eligible ≥60일) 종목 수
  aboveSma20Ratio: number;     // 0~1, 종가>20일SMA 비율
  aboveSma60Ratio: number;     // 0~1, 종가>60일SMA 비율
  medianDailyReturnPct: number;// 유니버스 1일 수익률 중앙값(%)
  medianRet5dPct: number;      // 유니버스 5일 수익률 중앙값(%)
  medianAtrPct: number;        // 유니버스 ATR% 중앙값
}
export interface RegimeResult {
  label: RegimeLabel;
  rawScore: number;            // 0~1 합성 점수(평활 전)
  smoothedScore: number;       // EMA 평활 후(히스테리시스 입력)
  slotMultiplier: number;      // 동시보유 상한 배수(스케일맵, market-data 산출)
  amountMultiplier: number;    // 종목당 투자금 배수(스케일맵)
  breadth: BreadthSnapshot;
  source: 'breadth' | 'fallback'; // 표본부족/예외 시 fallback(=NEUTRAL·1.0)
}
export interface ScanResponse {
  // ...기존 필드 비파괴...
  regime?: RegimeResult; // 신규 optional
}
```
backend(`scheduled-scanner`) 측 `ScanResponse` L61-66·`ScanResult` L49-59에 동일 optional 필드 미러링(런타임 무관, 타입 정합용).
**레짐 상태 영속화(히스테리시스용)**: JSON 파일 `data/market_regime_state.json`, 스키마 `{ prevSmoothedScore: number; prevLabel: RegimeLabel; updatedAt: string }`. `OptimalParamsService` writeToDisk/readFromDisk 패턴 그대로. **DB 엔티티/마이그레이션 없음.**

### 알고리즘

**1) 브레드스 집계 — chunk 루프 내 별도 경량 패스 (critical #1 핵심)**
`scanSingleStock` **밖에서**, chunk 루프(L867-896) 내 종목별로 다음을 누적한다. `scanSingleStock` 의 null 반환과 **완전 독립**(통과 못 한 종목도 집계 → 생존편향 제거). 모집단 = `eligibleStocks`(≥60일, L796).
```ts
// chunk 루프 안, scanSingleStock 호출과 별개 (try/catch 로 종목 단위 격리)
const prices = pricesByStockId.get(stock.id);
if (!prices || prices.length < 60) { /* 브레드스 집계도 스킵 */ }
else {
  const closes = prices.filter(p=>p.close!=null).map(p=>p.close!);
  if (closes.length >= 60) {
    const sma20 = lastOf(calculateSMA(closes, 20));   // (number|null)[] 의 마지막값
    const sma60 = lastOf(calculateSMA(closes, 60));
    const atr14 = lastOf(calculateATR(candles, 14));  // candles 는 close 보정 형태(L1017-1026 동일)
    const last = closes[closes.length-1];
    const prev = closes[closes.length-2];
    const c5   = closes[closes.length-6];
    if (sma20!=null && last>sma20) acc.aboveSma20++;
    if (sma60!=null && last>sma60) acc.aboveSma60++;
    if (prev>0) acc.dailyReturns.push((last-prev)/prev*100);
    if (c5!=null && c5>0) acc.ret5d.push((last-c5)/c5*100);
    if (atr14!=null && last>0) acc.atrPct.push(atr14/last*100);
    acc.universeCount++;
  }
}
```
- **CPU 비용 정량화(critical #1 요구)**: 전 eligible 종목(~2,886) × `calculateSMA(60)`(O(n·60)) + `calculateATR(14)`. `calculateSMA` 는 윈도우 합을 매 인덱스 재계산(L11-15)하므로 SMA60 가 약 131×60 ≈ 7.9k 연산/종목 → 전 종목 ≈ 2,300만 연산. 단일 스캔이 수만 종목·전략 조합으로 이미 수초~수십초 걸리는 점 대비 **<5% 증가, 무시 가능**. 단 `calculateSMA(closes,20)` 와 `(closes,60)` 은 마지막값만 필요하므로, 비용이 우려되면 **마지막 window 평균만 직접 계산하는 인라인 1줄**(closes.slice(-period) 평균)로 대체해 O(period) 1회로 낮춘다(권장). ATR도 마지막 14봉 TR 평균만.
- 누적은 카운터/배열 push 만 → 전 시계열 보관 금지(메모리 O(universeCount) 스칼라). chunk clear(L900) 와 무관.

**2) 브레드스 → 합성 점수 (순수 유틸 `computeMarketRegime`)**
신규 `libs/strategies/src/utils/market-regime.ts`. 입력 `BreadthSnapshot` + 이전 상태(`prevSmoothedScore`,`prevLabel`) + opts(임계). 출력 `RegimeResult`.
```
trendComponent  = clamp01(aboveSma60Ratio)                       // 추세 폭
momentumComp    = clamp01(0.5 + medianRet5dPct / REGIME_RET5D_SPAN) // ±span% → 0~1 (기본 span=10)
volComponent    = 1 - clamp01((medianAtrPct - VOL_FLOOR) / (VOL_CEIL - VOL_FLOOR)) // 1−vol percentile (고정임계)
rawScore = W_TREND*trend + W_MOM*momentum + W_VOL*vol            // 가중합, 합=1 (기본 0.4/0.2/0.4)
```
- **vol percentile = 고정 임계(high #5 핵심)**: 동적 백분위 폐기. `medianAtrPct` 를 `REGIME_VOL_FLOOR_PCT`(예 2.0)~`REGIME_VOL_CEIL_PCT`(예 6.0) 로 정규화. `universeCount < REGIME_MIN_BREADTH_SAMPLE`(기본 30)이면 vol 성분 중립(0.5) + `source='fallback'`·레짐 NEUTRAL 반환(분모 0/표본부족 방어).

**3) 플립플랍 방지 2겹 (high #6)**
- **1겹 EMA 평활**: `smoothedScore = prevSmoothedScore==null ? rawScore : EMA(rawScore, prevSmoothedScore, REGIME_MA_DAYS=5)` (EMA α=2/(N+1)). 첫 실행/상태없음 → smoothed=raw.
- **2겹 밴드 히스테리시스(진입≠이탈)**: `prevLabel` 기준으로 라벨 결정.
  - CRISIS: `smoothedScore < REGIME_CRISIS_ENTER(0.35)` 진입 / `≥ REGIME_CRISIS_EXIT(0.45)` 이탈
  - ATTACK: `smoothedScore > REGIME_ATTACK_ENTER(0.65)` 진입 / `≤ REGIME_ATTACK_EXIT(0.55)` 이탈
  - 0.35~0.45 / 0.55~0.65 데드밴드 → **직전 라벨 유지**.
- **최소유지일**: 같은날 수동 스캔+cron 재실행 시 진동 차단(`REGIME_MIN_HOLD_DAYS=1`; `updatedAt` 비교, 동일 영업일 내 라벨 변경 금지). 다중 인스턴스 경합은 `scheduled_job_locks`(scheduled-scanner L641-655)로 스캔이 직렬화되므로 없음 — JSON read-modify-write 안전.
- 영속화 읽기/쓰기 실패 → **raw 폴백(throw 금지)**, 첫날 진동 1회 감수.

**4) 레짐 → 익스포저 스케일맵 (market-data 산출, 응답 동봉)**
| 레짐 | slotMultiplier | amountMultiplier | 의미 |
|---|---|---|---|
| CRISIS | 0.5 | 0.6 | 노출 대폭 축소 |
| NEUTRAL | 0.8 | 0.8 | 기본(약보수) |
| ATTACK | 1.0 | 1.0 | 정상(확대는 옵트인) |
- **확대(>1.0)는 기본 1.0**. `REGIME_ATTACK_SLOT_MULT`/`REGIME_ATTACK_AMOUNT_MULT` 로만 옵트인. **슬롯×금액 동시 확대 금지**(high #4): ATTACK에서 둘 다 >1.0 로 두면 `effectiveMaxHoldings × amountMultiplier × per-stock-clamp-max(2.0)` 로 총 익스포저 폭주 → 구현 시 **둘 중 하나만 >1.0 허용하는 가드**(예: `if (slotMult>1 && amountMult>1) amountMult = 1`)와 로그 경고. 기본값(1.0/1.0)은 무영향.
- NEUTRAL 을 0.8 로 둔 건 단타 다종목에서 약보수 출발(설계 3 채택). NEUTRAL=1.0 을 원하면 config로 조정.

### 통합지점

**market-data (`backtest.service.ts scanAllStocks`)**
- 시그니처: 마지막 `scaleOutOptions` 객체와 별개로 **신규 options 객체 1개 추가**(medium #9 — 위치인자 금지):
  ```ts
  async scanAllStocks(
    ...기존 11개 인자..., scaleOutOptions: ScaleOutBacktestOptions = {},
    regimeCorrelationOptions: RegimeCorrelationOptions = {},  // 신규
  )
  interface RegimeCorrelationOptions {
    regimeEnabled?: boolean;         // market-data 측 마스터 토글
    correlationEnabled?: boolean;
    correlationCodes?: string[];     // 활성보유 코드(T2)
    prevRegime?: { prevSmoothedScore: number; prevLabel: RegimeLabel } | null;
  }
  ```
- chunk 루프(L867) 내: 브레드스 경량 패스 누적(위 알고리즘 1). 종목 단위 try/catch 로 격리(한 종목 실패가 집계 중단 X).
- 루프 종료 후(L901~L904 사이): `regimeEnabled` 면 `computeMarketRegime(snapshot, prevRegime, opts)` 호출 → `regimeResult`. 상태 JSON 저장(`{prevSmoothedScore, prevLabel, updatedAt}`). `regimeEnabled=false`/예외 → `regime` 미생성(또는 `source='fallback'`).
- `return` 에 `regime` 추가.
- **scanAllStocks 전체를 try/catch 로 감싸진 않되**, 레짐/클러스터 산출 블록만 try/catch — 실패 시 `regime=undefined`·`clusterId` 미부여로 기존 return 경로 유지.

**backend (`scheduled-scanner.service.ts`)**
- `requestScan` L187-200 emit payload 에 `correlationCodes: Array.from(activeCodes)`(T2용), `regimeEnabled`/`correlationEnabled`(market-data 토글 전달) 추가. (manual 종목은 스캐너 미관여라 correlationCodes 에서 제외.)
- `applyScanResults` L414(분산필터 시작) 직전:
  ```ts
  const regime = this.resolveRegimeScale(response); // OFF/null/예외 → {slotMultiplier:1, amountMultiplier:1}
  const effectiveMaxHoldings = Math.max(
    REGIME_MIN_HOLDINGS_FLOOR,                       // 하드 플로어=3
    Math.round(MAX_CONCURRENT_HOLDINGS * regime.slotMultiplier),
  );
  ```
  L418-421 `availableSlots` 계산을 `MAX_CONCURRENT_HOLDINGS` → `effectiveMaxHoldings` 로 치환.
- 종목당 금액: `computeVolatilityWeightedInvestments(toStart)` L463에 **base 배수 인자 1개 추가**(시그니처 비파괴 — optional param, 기본 1.0). L635 `SCAN_INVESTMENT_AMOUNT * weight` → `effectiveBase * weight`, 여기서 `effectiveBase = round(SCAN_INVESTMENT_AMOUNT * max(REGIME_AMOUNT_FLOOR, regime.amountMultiplier))`. **per-종목 clamp[0.5,2.0]·정규화는 불변**(파이 분배는 그대로). OFF 시 `effectiveBase = SCAN_INVESTMENT_AMOUNT`(비트단위 동일).
- `resolveRegimeScale(response)`: `REGIME_SCALING_ENABLED!=='true'` 또는 `response.regime==null` 또는 try/catch 예외 → `{slotMultiplier:1, amountMultiplier:1}`. market-data가 이미 산출한 `response.regime.slotMultiplier/amountMultiplier` 를 그대로 사용(스케일 계산은 market-data 단일 책임). backend는 토글 게이트 + floor + 곱셈만. (책임 배치는 low #1 인정: 추후 backend 잔고 결합이 필요하면 스케일 적용을 backend로 이동 — MVP는 현 구조 유지.)

### 상관캡과의 결합 순서
분산필터 단일 루프(L426-442)의 게이트 순서를 **고정**(T2 §결합순서 참조): activeCodes 제외 → (레짐 반영) 동시보유 → 섹터캡 → 클러스터캡. 동시보유 상한이 레짐으로 줄면 캡들은 더 적은 후보에만 작동 → 순서상 안전.

### config (전부 토글, 기본=기존 동작)
**backend `.env`/ConfigService**:
```
REGIME_SCALING_ENABLED=false        # 마스터 토글(이게 OFF면 신규 경로 early-return)
REGIME_MIN_HOLDINGS_FLOOR=3         # 노출 0 방지 하드 플로어
REGIME_AMOUNT_FLOOR=0.4
```
**market-data `.env`/ConfigService**(분류·스케일맵 원천):
```
REGIME_INDEX_SOURCE=breadth         # breadth|yahoo|hybrid (yahoo/hybrid 는 미구현→breadth 폴백)
REGIME_MA_DAYS=5
REGIME_MIN_HOLD_DAYS=1
REGIME_MIN_BREADTH_SAMPLE=30
REGIME_RET5D_SPAN=10
REGIME_VOL_FLOOR_PCT=2.0  REGIME_VOL_CEIL_PCT=6.0
REGIME_W_TREND=0.4  REGIME_W_MOM=0.2  REGIME_W_VOL=0.4
REGIME_CRISIS_ENTER=0.35  REGIME_CRISIS_EXIT=0.45
REGIME_ATTACK_ENTER=0.65  REGIME_ATTACK_EXIT=0.55
REGIME_CRISIS_SLOT_MULT=0.5   REGIME_CRISIS_AMOUNT_MULT=0.6
REGIME_NEUTRAL_SLOT_MULT=0.8  REGIME_NEUTRAL_AMOUNT_MULT=0.8
REGIME_ATTACK_SLOT_MULT=1.0   REGIME_ATTACK_AMOUNT_MULT=1.0
```
> **토글 양쪽 분리 주의(설계 3 리스크·low #1)**: market-data `REGIME_INDEX_SOURCE`/`regimeEnabled` OFF → `regime` 미산출 → backend `resolveRegimeScale` 가 자동 폴백(스케일 1.0). backend `REGIME_SCALING_ENABLED` OFF → 응답에 regime이 있어도 무시. **둘 다 ON 이어야 동작**. 로그에 `레짐 source=breadth/미수신`, `스케일 slot×N amount×N 적용/미적용` 명시 필수(운영자가 한쪽만 켜고 '동작 안 함' 오인 방지).

### 엣지케이스
- **유니버스 표본 부족**(eligible≈0, 휴장 직후/데이터 결손): `universeCount < REGIME_MIN_BREADTH_SAMPLE` → `source='fallback'`·NEUTRAL·스케일 1.0. pctAbove 분모 0 가드.
- **vol 표본 짧음(131일)**: 동적 백분위 대신 고정 임계(VOL_FLOOR/CEIL) 3구간 정규화로 안정화. 임계는 config 튜닝.
- **레짐 플립플랍**: 1일 1회 스캔이라 다회 표본 없음 → EMA(5)+밴드 히스테리시스(진입≠이탈)+최소유지일 2겹. 상태 JSON 부재/손상 → raw 폴백(throw 금지).
- **effectiveMaxHoldings < activeCodes.size**(CRISIS로 상한이 현재 보유보다 낮아짐): `availableSlots=max(0,...)=0` → **신규 진입만 차단, 기존 보유 강제청산 안 함**(MVP 비파괴). 이 경우 crisis인데 노출축소가 '신규차단으로만' 실현되어 지연 가능(medium #3) → **로그 경고** + 기존 세션 TP/SL 타이트닝·maxHoldingDays 단축은 **Sprint4 백로그**로 명시.
- **금액 스케일로 floor(amount/price)=0주**: `startSessions`/`executeBuy` 가 수량 0이면 이미 스킵(검증룰 동일). amountMultiplier 하한 0.4 + per-종목 clamp 하한 0.5로 방어.
- **ATTACK 확대로 effectiveMaxHoldings>실제 후보 수**: 슬롯만 늘고 후보가 없으면 변화 없음(상한 1.0 기본이라 폭주 없음).
- **rolling deploy**(구버전 market-data): `regime` 미산출 → backend 폴백(레거시). 신버전 backend+구버전 market-data 안전.
- **REGIME_INDEX_SOURCE=yahoo/hybrid**: 미구현→breadth 폴백, `source` 라벨 로그. 죽은 합성코드 없음.

### 수용 기준
- [ ] 토글 OFF(`REGIME_SCALING_ENABLED=false`)일 때 `applyScanResults`/`scanAllStocks` 출력이 현재와 **바이트 동일**: 채택 종목 집합 + `investmentByCode` 종목별 정수 금액 + `availableSlots` 전부 골든 비교(medium #1 — 채택집합만 비교 금지). OFF 경로는 신규 산술 경로를 타지 않게 **early-return**.
- [ ] ON: CRISIS에서 `effectiveMaxHoldings`·종목당 금액 축소(단 floor≥3·≥40%), ATTACK에서 정상(확대는 옵트인 시만). NEUTRAL=0.8 기본.
- [ ] 브레드스 집계가 `scanSingleStock` 통과 여부와 독립(생존편향 없음) — eligible 전수 모집단.
- [ ] EMA+밴드 히스테리시스로 경계 churn 억제(단위테스트로 검증).
- [ ] 노출 0 방지 floor 동작(CRISIS여도 최소 3슬롯·40%).
- [ ] 슬롯×금액 동시 확대 가드(ATTACK에서 총 익스포저 상한 명시 계산).
- [ ] market-data·backend 빌드/lint/test green, `@alpha-mind/strategies` build 선행.
- [ ] 예외/누락/표본부족 시 NEUTRAL·스케일 1.0 폴백(스캔/매매 무중단).

### 테스트
- `market-regime.spec.ts`(market-data, `@alpha-mind/strategies` dist import): 브레드스 0%/100% 경계→CRISIS/ATTACK, vol 고정임계 3구간, EMA 평활, 밴드 히스테리시스(0.40 경계서 prevLabel 유지), 표본<MIN→fallback·NEUTRAL, floor 하한.
- `scheduled-scanner.service.spec.ts`(존재 확인됨): 레짐 OFF 골든(스케일 1.0→슬롯수·금액 동일), ON CRISIS effectiveMaxHoldings 축소·금액 축소, ATTACK 확대 가드, `resolveRegimeScale` 폴백(regime=null/예외).

### 검증 방법 (포트폴리오 레이어 한계)
- **한계 명시**: 레짐 스케일은 포트폴리오 구성 레이어라 종목 단위 `runBacktest`/`scanSingleStock` 로 실거래 PnL 검증 불가(Sprint2 R사이징과 동일, 데이터 6개월·131거래일). 단일 종목 손익곡선에 '동시보유 13→15'의 효과가 안 나타남.
- **검증 1 — 순수함수 단위테스트**(필수, 결정적): 위 `market-regime.spec.ts`.
- **검증 2 — 오프라인 스냅샷 시뮬**(수용기준 필수로 승격, medium #2): 신규 스크립트 `apps/market-data-service/src/strategy/__sim__/regime-cluster-sim.ts`. 실 DB 최근 131일 각 영업일에 브레드스→레짐 시계열 산출. **정량 pass/fail 임계 고정**: ① 6개월 레짐 전환 횟수 ≤ `SIM_MAX_REGIME_FLIPS`(예 8 — 과진동 점검), ② OFF vs ON 채택 종목수 차이가 의도 방향(CRISIS일 축소). 실거래 PnL 검증은 불가임을 명시. **이 시뮬 미구현 시 임계 미검증 배포 위험** → DoD 필수 항목.

---

## T2. 상관/클러스터 캡

### 목표·근거
섹터캡(`MAX_PER_SECTOR=4`, scheduled-scanner L433-439)에 더해, **동시 보유 + 신규 후보 간** 일봉 수익률 상관 ρ>임계 묶음에서 N개 초과 동시 보유 제한 → 같은 테마 동반 손실 방지. 섹터캡은 분류 라벨 기반이라 섹터가 달라도 동조하는 테마(예 2차전지 소재+장비)를 못 막고, 섹터 미상 종목이 다수다 → 상관은 라벨 무관 실측 동조성을 캡.

### 현재 코드 (파일·라인)
- **상관 계산 위치(데이터 보유처)**: `backtest.service.ts scanAllStocks` chunk 루프 — 단 상관은 후보 간 + 활성 간이라 **Top N 확정(L905) 후** 계산이 효율적. chunk clear(L900) 전에 **Top N 후보 close[] 별도 보관 필요**(아래).
- **활성보유 부재**: active 종목은 `excludeCodes`(requestScan L181/L191)로 스캔에서 빠져 **스캔 결과·가격에 없음**. backend는 가격 시계열이 없음(`countSectors` L580-587 은 stocks 의 sector만 조회). → 혼합 상관엔 active close[] 별도 로드 필수(critical #2).
- **클러스터 적용 위치**: `scheduled-scanner.service.ts` 분산필터 단일 루프 L426-442.
- **호출부**: `scanAllStocks` production 호출 2곳(controller L329 HTTP, L363 RMQ). 둘 다 `ScanBodyDto`(`scan-query.dto.ts`) + `regimeCorrelationOptions` 전달.

### 데이터 모델
`scan.types.ts`:
```ts
export interface ScanResult { /* ...기존... */ clusterId?: number; }  // 같은 값=ρ>임계 묶음. 미할당=단독
export interface ScanResponse {
  // ...기존 + regime?...
  clusters?: Array<{ clusterId: number; codes: string[]; size: number }>; // backend 역매핑/진단용
}
```
backend `ScanResult` L49-59에 `clusterId?: number`, `ScanResponse` L61-66에 `clusters?` 미러링.
**핵심(critical #3)**: `clusterId` 는 '이번 스캔 로컬 id'다. 활성 세션이 어느 클러스터에 속하는지 backend가 알려면 `clusters[]`(clusterId↔codes, **활성종목 코드 포함**)가 필요. backend는 활성 세션 `stockCode → clusterId` 역매핑으로 `clusterCounts` 를 시드한다.

### 알고리즘

**1) 활성보유 close[] 별도 로드 (critical #2)**
`requestScan` payload `correlationCodes = Array.from(activeCodes)`(manual 제외) → `scanAllStocks(regimeCorrelationOptions.correlationCodes)`. market-data는 `correlationEnabled` 일 때 **chunk 모델 밖 1회 쿼리**로 active 종목 close[] 만 로드(OHLCV 불필요, ≤15종목, lookback `CORR_LOOKBACK_DAYS=60`). Top N 후보 close[] 는 chunk clear(L900) 전에 **별도 Map 으로 복사**(메모리 O(topN×60)≈35×60, 무시 가능). **전 종목 시계열 보관 금지**(OOM 회귀 — L804-817 주석).

**2) 상관·클러스터 (순수 유틸 `correlation-cluster.ts`)**
신규 `libs/strategies/src/utils/correlation-cluster.ts`:
```ts
export function pearson(a: number[], b: number[]): number; // NaN if std=0 or overlap부족
export function clusterByCorrelation(
  returnsByCode: Map<string, number[]>,   // code → 로그수익률 시계열
  opts: { threshold: number; minOverlap: number },
): { clusterByCode: Map<string, number>; clusters: { clusterId: number; codes: string[] }[] };
```
- 입력: 후보+활성 종목별 일봉 종가 → **로그수익률** `r_t = ln(close_t/close_{t-1})`. **공통 거래일 교집합**으로 정렬(날짜 키 매칭, 결손/상장폐지 갭 방어).
- 페어 Pearson ρ. **유효 겹침 < `CORR_MIN_OVERLAP=40`** 또는 std=0(거래정지·연속 상한가) → ρ=NaN → 간선 미생성.
- **클러스터링 = union-find 연결요소**. `ρ > CORR_THRESHOLD` 간선 연결. **코드 사전순 union** 으로 ID 결정성 확보(입력 rankScore 순서 무관).
- **상관만 사용 → 역행렬/촐레스키 없음** → 특이행렬 throw 원천 차단(설계 3 #9·critical 방어). std=0/NaN/표본부족 페어는 간선 미생성 → 해당 종목 singleton(캡 비적용).
- **전이연쇄 완화(high #7)**: `CORR_THRESHOLD` 기본을 **0.8**(0.7보다 보수)로 시작. 거대 클러스터(size > `CORR_MAX_CLUSTER_SIZE_WARN`=6) 발생 시 로그 경고 + `CORR_LINKAGE=average` 플래그(기본 union-find, 옵트인 시 average-linkage 격상) 자리 마련. average-linkage 실제 구현은 1차 union-find 로 두되 시뮬에서 클러스터 크기 분포 점검 후 결정.

**3) clusterId 부여**: Top N 확정(L905) 후 `clusterByCorrelation` 호출 → 각 `ScanResult.clusterId` 설정 + `ScanResponse.clusters[]`(활성종목 코드 포함) 채움. try/catch 폴백(예외 시 clusterId 전부 미설정 → backend 캡 자동 스킵).

**4) 클러스터 캡 적용 (backend, 3중 캡 단일 루프 — high #8)**
L426-442 단일 채택 루프를 게이트 추가로 확장. **카운터는 채택 직전 1회만 증가**(이중 제외 없음):
```ts
const clusterCounts = new Map<number, number>();
// 활성 세션 시드(critical #3): response.clusters[] 로 activeCode→clusterId 역매핑
if (CORRELATION_CAP_ENABLED && response.clusters) {
  const clusterOf = new Map<string, number>();
  for (const cl of response.clusters) for (const code of cl.codes) clusterOf.set(code, cl.clusterId);
  for (const code of activeCodes) {
    const cid = clusterOf.get(code);
    if (cid != null) clusterCounts.set(cid, (clusterCounts.get(cid) ?? 0) + 1);
  }
}
for (const c of buyCandidates) {
  if (activeCodes.has(c.stockCode)) continue;                       // 게이트0
  if (filteredCandidates.length >= availableSlots) {                // 게이트1: (레짐) 동시보유
    skippedByConcurrencyCap++; continue;
  }
  if (c.sector) {                                                   // 게이트2: 섹터캡(기존)
    if ((sectorCounts.get(c.sector) ?? 0) >= MAX_PER_SECTOR) { skippedBySectorCap++; continue; }
  }
  if (CORRELATION_CAP_ENABLED && c.clusterId != null) {             // 게이트3: 클러스터캡(신규)
    if ((clusterCounts.get(c.clusterId) ?? 0) >= MAX_PER_CLUSTER) { skippedByClusterCap++; continue; }
  }
  if (c.sector) sectorCounts.set(c.sector, (sectorCounts.get(c.sector) ?? 0) + 1);  // 채택 직전 1회
  if (CORRELATION_CAP_ENABLED && c.clusterId != null)
    clusterCounts.set(c.clusterId, (clusterCounts.get(c.clusterId) ?? 0) + 1);
  filteredCandidates.push(c);
}
```
로그에 `분산 필터 — 클러스터캡(${MAX_PER_CLUSTER}/클러스터) 초과 ${skippedByClusterCap}건 스킵` 추가(기존 L444-449 패턴).

### 기존 섹터/동시보유 캡과 결합 순서 (명문화)
- **순서 고정**: activeCodes 제외 → (레짐 반영) **동시보유** → **섹터캡** → **클러스터캡**. 동시보유캡이 최바깥(전체 슬롯 우선). 입력은 rankScore 내림차순(L413 가정·L904 정렬)이라 상위 우선 채택 불변식 유지.
- **이중 제외 없음**: 섹터로 컷된 종목은 클러스터 카운트 미증가(역도 동일) — 각 캡 카운터는 채택 직전 1회만. 섹터·클러스터는 독립 차원(섹터 달라도 클러스터 같으면 캡).
- **clusterId==null 비적용**: 상관 미산출/단독/CORR OFF → 클러스터캡 우회(섹터 미상 제외 정책 L412·`countSectors` L598과 대칭, '모르는 건 막지 않음').

### config (전부 토글, 기본 OFF)
**backend**:
```
CORRELATION_CAP_ENABLED=false
MAX_PER_CLUSTER=2          # ρ>임계 묶음 동시보유 상한(섹터캡 4보다 타이트)
```
**market-data**:
```
CORRELATION_THRESHOLD=0.8  # 보수 시작(전이연쇄 완화)
CORR_MIN_OVERLAP=40        # 공통 거래일 최소(공분산 신뢰 하한)
CORR_LOOKBACK_DAYS=60      # 상관 윈도우(131일 중 최근 60)
CORR_MAX_CLUSTER_SIZE_WARN=6
CORR_LINKAGE=union         # union|average (average 는 자리만, 1차 union)
```
> 토글 양쪽 분리: market-data `correlationEnabled` OFF → clusterId/clusters 미부여 → backend 캡 자동 우회. 둘 다 ON 일 때만 동작.

### 엣지케이스
- **활성보유 close[] 별도 로드 누락**(B-2 가장 치명적 회귀): 누락 시 활성 무시 클러스터캡이 되어 '활성+신규 동조' 방지 실패 → critical. 별경로 1회 쿼리 + `clusters[]` 활성코드 포함을 수용기준에 고정.
- **상관 NaN**(겹침<minOverlap=신규상장/거래정지, std=0): 간선 미생성 → singleton → clusterId 부여하되 단독이라 캡 비적용.
- **clusterId==null**(미산출/CORR OFF): 캡 비적용(섹터 미상 정책 대칭).
- **3중 캡 이중 제외**: 카운터 채택 직전 1회 → 방지(위 코드).
- **전이연쇄 거대 클러스터**: THRESHOLD 0.8 보수 + size>6 로그 경고 + 시뮬 크기 분포 점검. 강세장 채택 급감 시 average-linkage 격상 검토.
- **MAX_PER_CLUSTER=2 가 섹터캡=4보다 타이트**: 강세장 동일 테마 다수 후보가 클러스터로 묶여 채택 급감, `availableSlots` 미달 가능 → 임계·캡 N 시뮬 사전 점검 필수.
- **클러스터 ID 비결정성**: 코드 사전순 union 으로 고정(rankScore 순서 무관).
- **메모리**: Top N(≤35) + correlationCodes(≤15) close[] 만 보관. chunk clear(L900) 전 복사 필수(GC 소실 방지). 전 종목 보관 금지.
- **rolling deploy**: 구버전 market-data → clusterId/clusters 미부여 → backend 캡 자동 우회.
- **manual 종목**: correlationCodes 에서 제외(스캐너 미관여). active이면서 manual인 종목은 buyCandidates에서 이미 제거(L390-395) → 시드에서도 일관 제외.

### 수용 기준
- [ ] 토글 OFF 시 분산필터 출력 **바이트 동일**(채택집합 골든).
- [ ] ON: ρ>임계 묶음에서 `MAX_PER_CLUSTER` 초과 후보 스킵 + 로그. **활성보유가 이미 한 클러스터 N개면 신규는 그만큼 제한**(혼합 상관 — 핵심 시나리오 통과).
- [ ] `clusters[]` 에 활성종목 코드 포함, backend 역매핑 시드 동작.
- [ ] clusterId==null/예외 시 캡 자동 우회(폴백).
- [ ] 상관 유틸이 역행렬 없이 상관만 사용(특이행렬 throw 없음), 코드 사전순 ID 결정성.
- [ ] 빌드/lint/test green, `@alpha-mind/strategies` build 선행.

### 테스트
- `correlation-cluster.spec.ts`(libs/market-data): 완전동조 2종목 ρ≈1→동일 클러스터, 무상관→분리, 겹침<minOverlap→NaN→singleton, std=0→간선 미생성, 코드 사전순 ID 결정성, 전이연쇄(A~B 0.85, B~C 0.85, A~C 0.3)에서 union-find 한 클러스터 확인(THRESHOLD 동작 검증).
- `scheduled-scanner.service.spec.ts`: 클러스터 게이트 스킵 카운트, 활성 시드(clusters[] 주입→activeCode 시드→신규 제한), clusterId=null 우회, 3중 캡 이중제외 없음(섹터 컷 종목 클러스터 카운트 미증가).

### 검증 방법
- 위 단위테스트(결정적) + T1 오프라인 시뮬(`regime-cluster-sim.ts`)에 **클러스터 크기 분포 + OFF/ON 채택수 차이** 산출(육안 + 정량 임계). 동조장(전 종목 동반하락일)에 클러스터가 잡히는지 확인. 실거래 효과(동반손실 방지)는 정량 미검증 — 기본 OFF·페이퍼 검증 명시.

---

## 8. 작업 범위 밖 (이번 Sprint 제외)
- **VI(변동성완화장치)/NXT(대체거래소) 분기 주문처리** — 별도 스프린트.
- **레짐 신호의 기존 보유 반영**: CRISIS 진입 시 활성 세션 TP/SL 타이트닝·maxHoldingDays 단축·부분 강제축소 — 비파괴 원칙상 본 스프린트는 신규 진입 차단으로만 노출 축소(medium #3). Sprint4 백로그.
- **(b) yahoo / (c) DB 적재 레짐 출처** — enum/폴백 자리만, 실제 합성·수집기 구현 제외.
- **average-linkage 계층 클러스터** — config 자리만, 1차 union-find. 시뮬 결과 따라 후속.
- **backend 계좌 잔고 기반 동적 스케일 조정**(가용현금 결합) — 스케일 적용을 backend로 이동하는 책임 재배치 포함, 별도 스프린트.
- **레짐 상태 DB/공유스토어 영속화** — 다중 인스턴스 엄밀 정합. 현재는 `scheduled_job_locks` 직렬화 + JSON 파일로 충분(범위 외).

## 9. 완료 정의 (DoD)
- [ ] T1·T2 각 수용 기준 충족 + 단위 테스트 통과 + **토글 OFF 회귀 골든테스트(채택집합+종목별 정수 금액+availableSlots) 통과**.
- [ ] **오프라인 스냅샷 시뮬 스크립트 구현·실행**(수용기준 필수): 레짐 전환 횟수 ≤ 임계, 클러스터 크기 분포 산출, OFF/ON 채택수 차이 의도 방향 확인.
- [ ] `libs/strategies` 빌드 선행 후 `pnpm --filter @alpha-mind/strategies run build && pnpm -r run build` 성공, `pnpm -r run lint` 통과.
- [ ] 신규 유틸 호출 try/catch fail-safe(레짐=NEUTRAL·캡 미적용 폴백) 적용 확인 — 스캔/매매 무중단.
- [ ] **마이그레이션 없음**(JSON 파일 영속화) 확인. `correlationCodes`/`regimeCorrelationOptions` 는 options 객체(위치인자 아님), 호출부 2곳 디폴트 처리 확인.
- [ ] 각 작업 개별 커밋(T번호·요약), config 토글 기본값 OFF(`REGIME_SCALING_ENABLED=false`, `CORRELATION_CAP_ENABLED=false`) 확인. 양쪽 토글 분리 로그 명시.