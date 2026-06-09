# Sprint 4 구현 명세서 — 생존편향 보정 + 롤링 walk-forward (Codex 실행용)

> 목적: 백테스트/스캔 **검증 신뢰성** 2건 — **(A) 생존편향 보정**, **(B) 롤링 walk-forward** — 을 Codex가 구현하도록 정밀 명세.
> 합성 근거: 3관점 설계(MVP·최소위험 / 데이터현실·정직 / 정확성·엣지케이스) 병합. (적대적 리뷰·합성은 인터넷 불안정으로 미완 → 메인 루프 합성, 각 설계의 edgeCases·risks를 적대적 레이어로 흡수.)
> 작성 기준: 2026-06-09 master. 라인 인용은 실제 Read/Grep 확인.
> 🔴 **정직 원칙(불가침)**: (A)는 **과거 상폐 데이터 소급 복구가 원리적으로 불가능**하다. 본 스프린트는 "전향적(forward-only) 보존 + 현재 편향 caveat 정량화"만 한다 — **"생존편향 해결/보정 완료"로 위장 금지.** (B)는 보유 **약 131거래일** 한계상 폴드를 잘게 쪼개면 통계 무의미 → 폴드 수 상한·최소 거래수 가드 필수, "과적합 차단"만 보장하고 "통계적 유의성"은 주장하지 않는다.
> 두 기능 모두 **config 토글 기본 OFF**(`SURVIVORSHIP_RETAIN_DELISTED=false`, `ROLLING_WF_ENABLED=false`) — 토글 OFF 시 기존 동작과 **바이트 동일**.

---

## 0. Codex 작업 지침 (먼저 읽을 것)

- **레포**: pnpm workspace. 본 스프린트 주무대 = `apps/market-data-service`(스캔·백테스트·수집). `libs/strategies`는 **dist 소비** — 수정 시 `pnpm --filter @alpha-mind/strategies run build` 먼저. **본 스프린트는 libs 무수정 권장**(WF 폴드 헬퍼는 `backtest.service.ts` private로 두어 빌드 함정 회피).
- **마이그레이션**: `apps/market-data-service/src/config/mikro-orm.config.ts` (entities, migrations path `./dist/migrations`/pathTs `./src/migrations`). 기존 패턴 `Migration20260327100000.ts`(addSql up/down). 엔티티는 `market-data-service.module.ts`에도 등록(Stock는 이미 등록 — 컬럼 추가만이라 재등록 불요).
- **config 헬퍼**: `backtest.service.ts`에 `getNumberConfig(key, fallback)` 존재. **boolean 헬퍼 없음** → `getBooleanConfig(key, fallback)`(ConfigService 값이 `true`/`'true'`) 신규 추가.
- **검증**: `pnpm --filter @alpha-mind/strategies run build && pnpm -r run build`, `pnpm --filter @alpha-mind/market-data-service run test`, `pnpm -r run lint`.
- **가드레일**:
  1. 신규 동작 전부 **config 토글 기본 OFF**, 토글 OFF 시 기존 출력 **바이트 동일**(골든 스냅샷 테스트로 보증).
  2. Stock 신규 컬럼은 **전부 nullable·default** → 기존 행/upsert 비파괴. **NOT NULL 백필 금지**(상폐를 과거에 소급 적용 금지).
  3. **검증↔실전 정합 불변식**: WF 폴드 구조를 `scanSingleStock`과 `evaluateStockGridPoint`(그리드) **양쪽에 동일 적용**(한쪽만 고치면 그리드 최적 TP/SL과 스캔 검증이 어긋남).
  4. **정직 원칙 명문화**: 명세·코드 주석·로그·응답 메타에 "소급 불가·forward-only·131일 즉효 없음·여전히 낙관 편향"을 반복 명시.
  5. 각 작업 **단위 테스트** + **토글 OFF 회귀 골든테스트** 필수.
- **권장 순서**: (1) Stock 엔티티 3필드 + 마이그레이션 + `[OptionalProps]` → (2) `reconcileDelistings` + 가격 보존 + config → (3) `estimateSurvivorshipBias` caveat → (4) `buildWalkForwardFolds` + scanSingleStock 폴드 리팩터 → (5) evaluateStockGridPoint 동일 적용 → (6) 단위/회귀 테스트. 각 작업 개별 커밋.

- **핵심 결정**:
  1. 생존편향 데이터 출처 = **전향적 delistedAt 플래그-보존**(과거 복구 불가 정직 명시).
  2. 상폐 판정 단일 신호 = **CSV 탈락 streak**(가격 연속누락은 거래정지/휴장과 혼동 → 사용 금지), 히스테리시스 `DELIST_CONFIRM_DAYS=5` + CSV 손상 가드.
  3. WF = **앵커드(확장 윈도우)**(슬라이딩은 131일에서 in-sample 부족 → 비권장), **WF_MAX_FOLDS=3**, **WF_MIN_VALID_FOLDS=2**, 미달 시 단일 분할 폴백.
  4. 상폐 제외는 **코드 분기 단일 진실원**(DB `having>=60` 쿼리에서 빼지 말 것 — 빼면 백테스트 경로도 같이 잃음). 매수 스캔=제외 / 백테스트=포함.
  5. WF 폴드 **AND-통과 요구 금지**(통과 종목 급감→매수후보 0 수렴, Sprint3 OOS 임계 완화 이력의 함정) → 집계 OOS로 랭킹, 유효 폴드만.

---

## T1. 생존편향 보정 (전향적 보존 + 편향 정량화)

### 목표·근거
스캔/백테스트가 **현재 stocks 테이블 = 오늘 상장 종목**만 평가 → 성과 과대(리서치 확증: 모멘텀 CAGR 26%→12%, 약 2.1배 과대). 상폐/유니버스 이탈 종목을 **삭제 대신 보존**해 향후 편향 점감 + 현재 편향 caveat 정량화. **소급 보정은 불가** — forward-only.

### 현재 코드 (파일·라인)
- `apps/market-data-service/src/stock/entities/stock.entity.ts` L12-43: status/delisted/active **없음**(id/code/name/sector/currency/exchange/dailyPrices/createdAt/updatedAt), `[OptionalProps]` L14.
- `apps/market-data-service/src/stock/stock.service.ts`
  - `loadKrxCodes()` L166-174: `data/krx_codes.csv`(현재 상장만).
  - `collectAll()` L297-340: `krxCodes`만 순회(L312) → **CSV 탈락 종목은 방문조차 안 함**(삭제도 플래그도 없음 = "방치").
  - `collectStock()` L388-: upsert(create L401-408 / 갱신 L410-412), 가격정리 `nativeDelete(StockDailyPrice, {stock, date:{$lt:lookbackDate}})` L416-419. `COLLECTION_LOOKBACK_MONTHS=6` L22.
  - `onModuleInit` L131 `missingCount` = "savepoint 미생성=미수집"이지 **상폐 아님**(혼동 금지).
- `apps/market-data-service/src/strategy/backtest.service.ts` `scanAllStocks` L1057-: `em.find(Stock, {})` L1084(현재 유니버스 전부), ≥60거래일 필터 L1089-1100(`having count(*)>=60` L1094) → **유니버스=오늘 상장=생존편향**.

### 데이터 모델 (신규 3필드 — 전부 nullable, 기존 행 비파괴)
`Stock` 엔티티 추가:
```ts
@Property({ type: 'date', nullable: true })
delistedAt?: Date;              // CSV 탈락 확정 첫 날(상폐 추정일). null=상장 추정
@Property({ nullable: true, default: 0 })
missingFromCsvDays?: number;    // CSV 연속 누락 수집일(오탐 방지 카운터)
@Property({ type: 'date', nullable: true })
lastSeenInCsvAt?: Date;         // 마지막 CSV 존재일
```
- `[OptionalProps]`(L14)에 `'delistedAt' | 'missingFromCsvDays' | 'lastSeenInCsvAt'` 추가.
- 마이그레이션 `Migration<생성ts>.ts`(실제 생성일, 미래날짜 금지): `alter table "stocks" add column "delisted_at" date null, add column "missing_from_csv_days" int null default 0, add column "last_seen_in_csv_at" timestamptz null;` / down은 3컬럼 drop. **백필 없음**.

### 알고리즘 — 상폐 "판정 안 함", 히스테리시스로 오탐 흡수
상폐 API가 없고 신호는 "CSV 탈락"뿐 → ①진짜 상폐 ②임시 거래정지 ③티커변경 ④CSV 갱신 실패로 오염. 즉시 마킹 금지.

신규 `reconcileDelistings(krxCodeSet)` — `collectAll()` 시작부(L301 직후) 호출, 토글 OFF면 즉시 return:
```
// CSV 손상 가드: 이번 CSV 종목수가 직전 대비 급감(<0.5×)이면 reconcile 전체 스킵(부분 CSV로 대량 오탐 방지)
if (csvCount < prevCsvCount * 0.5) { log('CSV 손상 의심 — reconcile 스킵'); return; }
const csv = new Set(krxCodes.map(k => k.code));
for (const s of await em.find(Stock, {})) {
  if (csv.has(s.code)) {                          // 재등장 → 오탐/재상장 자동복구
    s.lastSeenInCsvAt = today; s.missingFromCsvDays = 0; s.delistedAt = null;
  } else {
    s.missingFromCsvDays = (s.missingFromCsvDays ?? 0) + 1;
    if (s.missingFromCsvDays >= DELIST_CONFIRM_DAYS && s.delistedAt == null)
      s.delistedAt = s.lastSeenInCsvAt ?? today;  // 상폐 추정일 = 마지막 관측일
  }
}
```
- `DELIST_CONFIRM_DAYS=5`(≈1주) → 임시정지·티커변경·1회 CSV 누락 흡수. **거래정지는 CSV에 잔존하므로 streak=0 유지 → 오판 안 함.** 티커변경은 구코드가 보수적으로 상폐 처리되며 **데이터 보존**(잘못 삭제 안 됨).
- **소급 불가**: 카운터는 지금부터 증가. 과거 이미 사라진 종목은 끝내 표식 못 받음.

### 가격 보존 (정리 충돌 해소)
- 상폐 확정 종목은 `collectAll` targets(CSV 기반)에 자연 부재 → `collectStock` 미진입 → `nativeDelete`(L416) 미발동(자연 보존). **추가로** 별도 정리 경로/cron이 생길 경우 토글 ON 시 `delistedAt IS NULL` 가드를 명문화.
- **무한 누적 캡**: `DELISTED_RETENTION_MONTHS=12` 초과 보존분은 정리 허용(현행 131일 백테스트엔 충분, DB 증식 방지).

### 유니버스 반영 — 매수 스캔(제외) vs 백테스트(포함) 구분
- `scanAllStocks` L1098-1100 `eligibleStocks` 필터에 코드 분기: `SCAN_INCLUDE_DELISTED_FOR_BACKTEST` OFF(매수 후보 스캔)면 `s.delistedAt == null`만, ON(백테스트)면 `delistedAt == null || delistedAt > windowEnd`(당시 상장).
- **DB `having>=60` 쿼리(L1094)에서는 상폐 제외하지 말 것** — 빼면 백테스트 경로도 잃음. 제외는 **코드 분기 단일 진실원**. 상폐 종목이 보존 데이터 60↑이면 백테스트 후보, 매수 스캔에선 코드에서 컷.
- `calculateScanRankScore`는 무수정.

### 현재 편향 정량화 (caveat — 핵심 산출물)
신규 `estimateSurvivorshipBias()` — `scanAllStocks` 응답 메타에 첨부(토글 무관 항상 산출):
- 입력 가정(투명·config): `SURVIVORSHIP_ASSUMED_DELIST_RATE_ANNUAL`(기본 0.02), `AVG_DELIST_LOSS_FRACTION`(기본 0.5). 윈도우 환산 + 리서치 앵커(CAGR 26%→12%).
- 출력: `{ universeSize, delistedRetained, assumedAnnualDelistRate, estimatedReturnHaircutPct, researchAnchor: "CAGR 26%→12%(모멘텀, 외부)", note: "전향적 보존 시행 전 구간은 소급 보정 불가. 가정 기반 추정이며 실측 아님. OOS 성과는 이만큼 과대평가됐을 수 있음" }`.
- **성과 수치에서 빼지 않는다**(허위 정밀 회피) — 경고만 동반.

### config
| 키 | 기본 | 효과 |
|---|---|---|
| `SURVIVORSHIP_RETAIN_DELISTED` | false | OFF=reconcile 미실행(현행). ON=delistedAt 보존 |
| `SURVIVORSHIP_DELIST_CONFIRM_DAYS` | 5 | CSV 연속 누락 확정 수집일 |
| `SCAN_INCLUDE_DELISTED_FOR_BACKTEST` | false | 백테스트 유니버스에 상폐 포함(매수 스캔은 항상 제외) |
| `DELISTED_RETENTION_MONTHS` | 12 | 보존 가격 상한 |
| `SURVIVORSHIP_ASSUMED_DELIST_RATE_ANNUAL` / `AVG_DELIST_LOSS_FRACTION` | 0.02 / 0.5 | caveat 정량화 가정 |

### 엣지케이스
- 과거 상폐 소급 불가(복구 0) → forward-only 명시. 131일 즉효 없음(보존≈0) 명시.
- CSV 1회 부재 오탐 → 5일 히스테리시스 + 재등장 자동해제. CSV 손상(급감) → reconcile 스킵.
- 임시 거래정지(CSV 잔존) → 오판 안 함. 티커변경 → 구코드 보존.
- 보존 종목 가격정리 충돌 → freeze + RETENTION 캡.
- 토글 OFF → 현행 바이트 동일.

### 수용 기준 / 테스트
- [ ] `reconcileDelistings`: CSV 존재→streak0·delistedAt null / 5일 부재→마킹 / 4일 후 재등장→미마킹(오탐) / 재상장→해제 / CSV 급감→스킵.
- [ ] 토글 OFF면 reconcile 미실행, `scanAllStocks` 출력 현행 동일(골든).
- [ ] `estimateSurvivorshipBias` 결정성 + 항상 산출.
- [ ] 매수 스캔=상폐 제외 / 백테스트 토글 ON=포함.

---

## T2. 롤링 walk-forward (앵커드 확장 윈도우)

### 목표·근거
현행 **단일 분할**(in-sample 2/3 + OOS 1/3)은 "운 좋은 단일 OOS" 과적합 위험. 다구간 폴드로 분산. **단 131거래일 한계** → 앵커드 소수(≤3) 폴드 + 폴드수 상한 + 최소 거래수 가드. "과적합 차단"만 보장, "통계 유의성" 주장 안 함.

### 현재 코드 (파일·라인)
- `backtest.service.ts`: `OUT_OF_SAMPLE_RATIO=1/3` L222, `MIN_IN_SAMPLE_TRADES=5` L224, `MIN_OUT_OF_SAMPLE_TRADES=2` L226.
- **WF 분할 2지점(동일 로직)**:
  - `scanSingleStock` L1464-: `splitIdx=floor(len*(1-ratio))` L1494, inSample slice L1495, OOS slice L1496, 표본가드 L1497-1502, in-sim L1563-1571, OOS-sim L1574-1584, combinedTrades L1587, **rankScore=OOS 기준** L1606-1611, 외부필드 OOS L1645-1677.
  - `evaluateStockGridPoint` L2063-: 동일 분할 L2085-2087(그리드 점 산출).
- `calculateScanRankScore` L1688-: OOS BacktestResult 입력.

### 데이터 모델
- **DB 변경 없음**(in-memory 분할). `ScanResult.folds?: FoldResult[]` **옵셔널 필드**만 추가(비파괴).

### 알고리즘 — 앵커드 폴드
신규 private `buildWalkForwardFolds(len): Fold[]`. 토글 OFF면 **단일 분할 1폴드 반환**(기존 splitIdx와 바이트 동일).
- 앵커드: in-sample 시작=0 고정, OOS 창만 전진(슬라이딩은 in-sample 부족으로 비권장).
- `MIN_INSAMPLE_LEN=30`(L1498 일관), `MIN_OOS_LEN=MIN_OUT_OF_SAMPLE_TRADES+10=12`(L1499 일관).
- `K = min(WF_MAX_FOLDS, floor((len - MIN_INSAMPLE_LEN)/MIN_OOS_LEN))`, `WF_MAX_FOLDS=3`.
- fold i: `oosStart = MIN_INSAMPLE_LEN + i*oosStep`, `oosEnd = min(oosStart+oosLen, len)`, `inSample = candles.slice(0, oosStart)`, `oos = candles.slice(oosStart, oosEnd)`.
- **🔴 look-ahead 차단**: in-sample은 항상 `slice(0, oosStart)` — OOS 시작 이전 봉만(미래 봉 절대 미참조). 지표 전체 1회 분석(L1540) 후 날짜맵 공유해도 폴드 시뮬은 폴드 캔들 범위만.

### 폴드 가드·집계 (131일 정직)
- 폴드별 `inSample.totalTrades<5 || oos.totalTrades<2`면 그 폴드만 제외(기존 L1570/L1581 로직을 폴드 루프 내부로).
- **유효 폴드 < `WF_MIN_VALID_FOLDS`(2)면 종목 null**(통계 무의미 차단) — 또는 단일 분할 폴백(택1, config).
- 집계 `aggOos`: 전 폴드 OOS trades **합산 시퀀스로 재계산**(drawdown까지 일관) — winRate=합산 승/총, totalTrades=합산, maxDrawdownPct=폴드별 최악(보수적). `wfConsistency = 수익 양(+) 폴드 / 유효 폴드`(부호 뒤집힘=운 신호→감점).
- **AND-통과 요구 금지**(후보 0 수렴 함정) → 집계 OOS 기준 단일 판정.

### 통합지점 (정합 필수)
- `scanSingleStock` L1493-1502 단일분할 → `buildWalkForwardFolds` 폴드 루프. L1606 `calculateScanRankScore` 인자 `outOfSample`→**`aggOos`**(시그니처 무변경). 외부필드 L1645-1677도 `aggOos` 기준. `inSample`/`outOfSample` 응답블록은 "집계" 의미 주석.
- `evaluateStockGridPoint` L2085-2087 → **같은 `buildWalkForwardFolds` 재사용**(그리드도 롤링 일관). 토글 OFF면 단일.
- `wfConsistency`는 rankScore에 `+wfConsistency*WF_CONSISTENCY_WEIGHT`(기본 0=영향없음) 보너스항.

### config
| 키 | 기본 | 효과 |
|---|---|---|
| `ROLLING_WF_ENABLED` | false | OFF=단일 1폴드(현행), ON=앵커드 롤링 |
| `WF_MAX_FOLDS` | 3 | 131일 상한 |
| `WF_MIN_VALID_FOLDS` | 2 | 미달 시 null/폴백 |
| `WF_MODE` | "anchored" | anchored\|sliding(비권장) |
| `WF_CONSISTENCY_WEIGHT` | 0 | 폴드 부호 일관성 가점 |

### 엣지케이스 / 수용 기준 / 테스트
- [ ] `buildWalkForwardFolds(131)` → 앵커드 폴드 ≤3, 각 `inSample.end==oos.start`(look-ahead 0), 유효폴드<2면 null/폴백.
- [ ] **토글 OFF → 단일 1폴드 = 기존 splitIdx 바이트 동일**(골든 회귀).
- [ ] 집계 winRate/trades 합산 정확, `wfConsistency` 계산.
- [ ] `scanSingleStock`·`evaluateStockGridPoint` **동일 폴드 구조**(정합) 테스트.
- [ ] 131일 한계 명시(로그/문서): "폴드당 OOS 2~5건은 추세 일관성 확인까지만 유효, 절대치 과신 금지".

---

## 8. 작업 범위 밖
- **과거 상폐 데이터 소급 복구**(원리적 불가). **티커변경 병합**(구↔신 코드 매핑) — 보존 우선, 병합은 별도.
- 외부 상폐 데이터셋(KRX 상장폐지 공시) 연동 — 도입 시 소급 일부 가능하나 별도 데이터 파이프라인.
- 슬라이딩 WF 실사용(131일에선 비권장, config 자리만).

## 9. 완료 정의 (DoD)
- [ ] T1·T2 수용 기준 + 단위 테스트 + **토글 OFF 회귀 골든테스트** 통과.
- [ ] `pnpm --filter @alpha-mind/strategies run build && pnpm -r run build` 성공, `pnpm -r run lint` 통과.
- [ ] 마이그레이션 생성·적용(실제 생성일, 미래날짜 금지), `[OptionalProps]` 갱신.
- [ ] WF 폴드 구조 `scanSingleStock`·`evaluateStockGridPoint` **양쪽 적용**(정합 불변식).
- [ ] **정직 원칙**: 소급불가·forward-only·131일 한계가 명세·로그·응답메타에 명시.
- [ ] 각 작업 개별 커밋(T번호), config 토글 기본 OFF 확인.
