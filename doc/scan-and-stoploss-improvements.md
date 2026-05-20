# 종목 스캔 추출률 + 손절 빈도 개선 (2026-05-20)

## 1. 문제 정의

사용자 보고:

1. `/market-api/strategies/scan` 응답에서 추출되는 종목 수가 너무 적다 — 필터가 과도하게 보수적.
2. 추출되어 자동매매로 진입한 종목이 손절 처리되는 비율이 높다.

이 문서는 두 문제의 원인을 진단하고 코드를 어떻게 변경했는지 정리한다. Codex 검증용.

---

## 2. 진단

### 2.1 추출이 적은 이유 — 4겹 보수 필터

스캔 한 종목이 결과에 포함되려면 다음 모두를 통과해야 한다.

**A. `evaluateLongBuyRisk` (libs/strategies/src/utils/buy-risk-filter.ts)** — 6개 조건 동시 통과
- 20일 평균 거래대금 ≥ 3억원
- ATR% ≤ 8%
- 최근 5일 수익률 ≥ -7%
- SMA60 대비 ≥ -8%
- SMA20 대비 ≤ +12%
- SMA20 5일 기울기 ≥ -0.5%

**B. OOS(out-of-sample) 품질 필터 (apps/market-data-service/src/strategy/backtest.service.ts)** — 4개 동시 통과
- 승률 ≥ 50%
- profit factor ≥ 1.2
- expectancyPct > 0
- 수익/MDD ≥ 0.35

**C. Walk-forward 거래수 요건**
- in-sample ≥ 5건, OOS ≥ 2건, 합산 ≥ 10건

**D. `pickFreshCurrentSignal` (libs/strategies/src/utils/signal-freshness.ts)**
- 신호 날짜가 lastCandle 날짜와 **정확히 일치**(같은 일자)할 때만 currentSignal로 채택. 어제 신호도 stale로 탈락.

**E. 이중 검증**
- 스캔: `MIN_BUY_SIGNAL_STRENGTH = 0.65`
- 실거래 진입 (`auto-trading.service.ts`): `MIN_SCHEDULED_BUY_SIGNAL_STRENGTH = 0.70` — 스캔 통과 후보가 다시 한 번 더 엄격한 임계로 거름

### 2.2 손절이 자주 나는 이유

**A. 종목 변동성과 무관한 고정 SL**
`scheduled-scanner.service.ts`의 fallback이 `TP=1.8%, SL=-1.8%`. 한국 단타 종목의 일일 ATR이 보통 2~4%이므로, 매수 직후 일중 노이즈만으로 -1.8%에 도달 가능.

**B. 진입 직후 즉시 본전/트레일링 청산**
`useNextOpenForBuy=true` 정책 상 다음봉 시가 매수. 시가 갭상승 후 되돌리거나 시가 갭다운으로 시작하면, 진입 직후 곧바로 본전 보호(`+1.0%` 찍었다가 `+0.1%` 내려오면 청산) 또는 트레일링 스톱이 발동하는 경우 발생.

**C. 1:1 손익비**
TP/SL이 대칭(±1.8%)이면 break-even 승률이 ~52% 필요. OOS 통과 임계가 50% 승률이므로 fielding이 막 OOS를 통과한 종목은 라이브에서 손익비 우위 없음.

**D. 슬리피지/거래세 미반영 격차**
백테스트는 슬리피지/거래세를 반영하지만, 실시간 매매에서 시장 충격 + 호가 vs 체결 격차가 추가로 발생.

---

## 3. 적용된 변경

초기 변경 이후 Codex 검토 반영으로 공용 유틸/테스트/타입까지 확장.

### 3.1 `libs/strategies/src/utils/signal-freshness.ts`

**변경 의도**: 새벽 8시 스캔이 어제 종가 신호로 오늘 시가 매수까지 활용 가능하도록 freshness window를 1→2거래일로 확장.

**변경 내용**
- `DEFAULT_FRESH_SIGNAL_WINDOW_DAYS = 2` 상수 추가.
- `FreshSignalOptions` 추가: `windowDays`, `tradingDates` 옵션 지원.
- `isFreshSignal(signal, lastCandle, options?)` — `tradingDates`가 있으면 캘린더일이 아니라 실제 캔들 거래일 간격으로 판단.
- `pickFreshCurrentSignal(...)` — currentSignal 의미에 맞게 fresh window 안의 **최신 신호**를 반환.
- `pickFreshStrongestSignal(...)` 신규 추가 — 스캔 후보처럼 특정 방향만 필요할 때 fresh BUY 중 최대 강도 신호를 별도로 선택.
- 주말/휴장일을 낀 금요일→월요일 신호도 직전 거래일 신호로 fresh 처리.

**호환 영향**
- 함수 시그니처는 숫자형 window 인자를 계속 받을 수 있어 기존 호출 하위호환.
- 동작 측면: 직전 거래일 BUY도 스캔 후보 신호로 활용 → 추출률 증가. currentSignal은 최신 방향 표시 의미를 유지.

**관련 호출 위치 (메시지만 일치 업데이트)**
- `candle-pattern.strategy.ts:130` — stale reason "최근 1거래일" → "최근 2거래일"
- `momentum-power.strategy.ts:204-205` — 동일
- `infinity-bot.strategy.ts:131` — 동일

### 3.2 `libs/strategies/src/utils/buy-risk-filter.ts`

**변경 의도**: 단기 조정 후 반등 후보, 강세 추세 종목, 변동성 우량 후보 등 알파가 살아있는 종목까지 차단하던 임계 완화.

**`DEFAULT_OPTIONS` 변경**

| 항목 | 기존 | 변경 | 이유 |
|------|------|------|------|
| `maxAtrPct` | 8 | 10 | 단타 종목은 변동성 자체가 alpha 원천 |
| `maxRecent5dDropPct` | -7 | -10 | -7~-10% 구간은 단기 눌림목 반등 후보 |
| `maxAboveSma20Pct` | 12 | 18 | 강세 추세 종목 SMA20 대비 +12% 이상도 모멘텀 지속 |
| `minSma20Slope5dPct` | -0.5 | -1.0 | 살짝 횡보 중인 종목까지 허용 |

나머지 4개 임계(`minCandles=60`, `minAvgTurnover20=3억원`, `maxBelowSma60Pct=-8`, `useCompletedCandlesForTurnover=false`)는 유지.

### 3.3 `apps/market-data-service/src/strategy/backtest.service.ts`

**변경 의도**: 한국 단타 시장 특성(승률 45~55%, PF 1.0~1.3)에 맞춰 OOS 품질 임계 완화. 기존 임계는 통과 종목이 거의 0건으로 수렴.

**상수 변경**

| 항목 | 기존 | 변경 |
|------|------|------|
| `MIN_OOS_WIN_RATE` | 50 | 45 |
| `MIN_OOS_PROFIT_FACTOR` | 1.2 | 1.1 |
| `MIN_OOS_RETURN_TO_DRAWDOWN` | 0.35 | 0.25 |
| `MIN_OOS_EXPECTANCY_PCT` | 0 | 0 (유지) |

walk-forward 거래수 요건(`MIN_IN_SAMPLE_TRADES=5`, `MIN_OUT_OF_SAMPLE_TRADES=2`, `DEFAULT_MIN_TOTAL_TRADES=10`)은 통계 유의성 확보를 위해 유지.

### 3.4 `apps/backend/src/auto-trading/auto-trading.service.ts`

**변경 의도**:
1. 스캔↔실거래 매수 임계 통일 (이중 검증 누수 차단)
2. 본전/트레일링 임계 강화 (작은 이익 양보하지 않음)
3. 진입 직후 grace period로 시가 매수 직후 즉시 청산 방지

**상수 변경**

| 항목 | 기존 | 변경 | 이유 |
|------|------|------|------|
| `MIN_SCHEDULED_BUY_SIGNAL_STRENGTH` | 0.70 | 0.65 | 스캔 임계(0.65)와 통일 — 후보 누수 차단 |
| `TRAILING_STOP_TRIGGER_PCT` | 1.2 | 1.8 | 더 큰 이익 확보 후에만 트레일링 |
| `TRAILING_STOP_GIVEBACK_PCT` | 0.8 | 1.2 | 일중 노이즈 흡수폭 확대 |
| `BREAKEVEN_TRIGGER_PCT` | 1.0 | 1.5 | 본전 보호 더 보수적 발동 |
| `BREAKEVEN_FLOOR_PCT` | 0.1 | 0.0 | 정확히 본전에서만 청산 |
| `POSITION_GRACE_PERIOD_MS` | — | 5분 (신규) | 진입 직후 본전/트레일링 비활성 |

**`evaluateAndExecuteSell` 로직 변경**
- 본전 보호 / 트레일링 스톱 조건에 `!inGracePeriod` 가드 추가.
- 큰 손실 (`stopLossPct`) / 큰 이익 (`takeProfitPct`) / 최대 보유기간은 grace period와 무관하게 그대로 작동 — 극단 상황 보호는 유지.

```typescript
const inGracePeriod =
  enteredAtMs != null && Date.now() - enteredAtMs < POSITION_GRACE_PERIOD_MS;
```

`session.enteredAt`은 entity에 이미 존재하므로 마이그레이션 불필요.

### 3.5 `apps/backend/src/auto-trading/scheduled-scanner.service.ts`

**변경 의도**:
1. Fallback TP/SL 비대칭화 — 손익비 우위 확보
2. 종목별 ATR 기반 동적 TP/SL — 변동성 큰 종목은 손절폭/익절폭 자동 확장

**상수 추가/변경**

| 항목 | 기존 | 변경 |
|------|------|------|
| `SCAN_AUTO_TAKE_PROFIT_PCT` | 1.8 | 2.5 |
| `SCAN_AUTO_STOP_LOSS_PCT` | -1.8 | -2.0 |
| `DEFAULT_DYNAMIC_TP_SL_OPTIONS.stopLossAtrMultiplier` | — | 1.3 (신규) |
| `DEFAULT_DYNAMIC_TP_SL_OPTIONS.takeProfitAtrMultiplier` | — | 1.8 (신규) |
| `DEFAULT_DYNAMIC_TP_SL_OPTIONS.maxStopLossPct` | — | 5.0 (신규) |
| `DEFAULT_DYNAMIC_TP_SL_OPTIONS.maxTakeProfitPct` | — | 6.0 (신규) |

**신규 공용 함수 `computeAtrDynamicTpSl(baseTpPct, baseSlPct, volatilityPct)`**

종목 변동성(ATR%)에 비례해 TP/SL을 동적 산출.
- `volatilityPct`가 없거나 0 이하 → `base` 그대로 반환 (안전 fallback).
- `SL_abs = min(maxStopLossPct, max(|baseSl|, vol × 1.3))`
- `TP = min(maxTakeProfitPct, max(baseTp, vol × 1.8))`

예시:
- ATR 2.0% → SL = max(2.0, 2.6) = -2.6%, TP = max(2.5, 3.6) = 3.6%
- ATR 3.5% → SL = max(2.0, 4.55) = -4.55%, TP = max(2.5, 6.0)-cap = 6.0%
- ATR 1.2% → SL = max(2.0, 1.56) = -2.0%, TP = max(2.5, 2.16) = 2.5% (작은 변동성 종목은 base 유지)

**적용 위치**
- `libs/strategies/src/utils/dynamic-tp-sl.ts` 공용 유틸로 ATR TP/SL 공식 이동.
- market-data 스캔 백테스트에서 종목별 ATR 보정 TP/SL을 먼저 적용.
- `ScanResult.autoTakeProfitPct / autoStopLossPct`로 검증에 사용한 값을 응답에 포함.
- backend `toResume` / `toStart`는 ScanResult의 검증 TP/SL을 그대로 세션에 반영.
- rolling deploy 중 구버전 market-data 응답에는 동일 공용 공식으로 fallback 계산.

**로그 메시지 업데이트**: 알림과 로그에 `ATR ${volatilityPct}%` 표기 추가 → 디버깅 시 추적 가능.

### 3.6 테스트 변경

**`apps/backend/src/auto-trading/auto-trading.service.spec.ts`**

기존 테스트 1건 임계값 갱신 + 신규 1건 추가.

- `triggers trailing stop after a profitable move gives back gains`
  - 새 임계(`TRIGGER=1.8`, `GIVEBACK=1.2`)에 맞춰 케이스 조정: peak 102.5(+2.5%), 현재 100.85(+0.85%, giveback 1.61%) → 트리거.
  - `enteredAt`을 30분 전으로 설정해 grace period 밖이 되도록.

- `does not trigger trailing stop during the grace period right after entry` (신규)
  - 동일 가격 조건이지만 `enteredAt`을 1분 전으로 → grace period 안 → 트리거되지 않음 검증.

---

## 4. 영향도 분석

### 4.1 추출률 (예상)
- 리스크 필터 4개 임계 완화 → 통과 종목 수 증가
- OOS 품질 임계 3개 완화 → 백테스트 통과 종목 수 증가
- 신호 freshness 1→2거래일 → 직전 거래일 BUY 신호도 스캔 매수 후보로 포함
- 매수 임계 0.70→0.65 → 스캔 후보의 실거래 통과율 ~30% 증가

정확한 효과는 실제 데이터로 측정 필요하나, 4가지 변경이 곱해진 효과로 결과 수 수배 증가 예상.

### 4.2 손절 빈도 (예상)
- ATR 기반 동적 SL → 변동성 큰 종목의 노이즈 손절 방지
- 진입 직후 5분 grace period → 시가 매수 직후 본전/트레일링 청산 방지
- 본전/트레일링 임계 강화 → 작은 이익 회수 빈도 감소, 큰 이익 가능성 ↑
- TP/SL 비대칭(2.5/-2.0) → break-even 승률 ~44%로 하락, 작은 마진 종목도 +EV

### 4.3 회귀 위험
- **낮음**: 신호 freshness window 인자는 optional, 기본 동작 변경이 명시적.
- **중간**: 리스크 필터 완화로 변동성 큰 종목이 포함되는데, ATR 기반 동적 SL이 보완.
- **낮음**: 본전/트레일링 임계는 코드 상수, 데이터 마이그레이션 불필요.
- **낮음**: 세션 entity 변경 없음 — `session.enteredAt`은 기존 필드.

---

## 5. 테스트 결과

```
백엔드 auto-trading + scheduled-scanner: 8/8 통과
마켓데이터 signal-freshness + dynamic-tp-sl + backtest: 9/9 통과
마켓데이터 strategy.spec.ts: 24/24 통과
```

---

## 6. 변경 파일 목록

```
apps/backend/src/auto-trading/auto-trading.service.spec.ts     | +36 / -3
apps/backend/src/auto-trading/auto-trading.service.ts          | +27 / -7
apps/backend/src/auto-trading/scheduled-scanner.service.spec.ts | 스캔 검증 TP/SL 반영 테스트 추가
apps/backend/src/auto-trading/scheduled-scanner.service.ts      | ScanResult TP/SL 우선 사용
apps/frontend/src/types/scanner.ts                              | ScanResult TP/SL 타입 추가
apps/market-data-service/src/strategy/backtest.service.ts       | ATR TP/SL로 OOS 검증 + fresh BUY selector 사용
apps/market-data-service/src/strategy/dynamic-tp-sl.spec.ts     | 신규
apps/market-data-service/src/strategy/signal-freshness.spec.ts  | 신규
apps/market-data-service/src/strategy/types/scan.types.ts       | ScanResult TP/SL 타입 추가
libs/strategies/src/index.ts                                    | 공용 유틸 export
libs/strategies/src/strategies/*                                | tradingDates 전달
libs/strategies/src/utils/buy-risk-filter.ts                   | +12 / -3
libs/strategies/src/utils/dynamic-tp-sl.ts                      | 신규
libs/strategies/src/utils/signal-freshness.ts                   | 거래일 window + selector 분리
```

---

## 7. Codex 검증 시 확인 포인트

1. **`computeAtrDynamicTpSl` 경계 처리**: `volatilityPct`가 undefined/0/음수/Infinity일 때 안전 fallback이 동작하는가?
2. **Grace period vs `enteredAt` null**: `enteredAt`이 설정되지 않은 세션(과거 데이터)에서 본전/트레일링이 정상 작동하는가? — 현재 코드는 `enteredAtMs != null` 가드로 null이면 `inGracePeriod=false`이므로 기존 동작 유지.
3. **fresh 신호 선택 역할 분리**: `pickFreshCurrentSignal`은 최신 상태 표시, `pickFreshStrongestSignal`은 스캔용 방향 필터로 분리됨.
4. **OOS 품질 임계 완화의 부작용**: 승률 45%/PF 1.1은 break-even에 매우 가깝다. 변경된 TP/SL 비대칭(2.5/-2.0)이 이를 +EV로 만드는가? — 가정상 그렇지만 실제 데이터로 검증 필요.
5. **ATR 기반 SL 최대 5%의 정당성**: 한국 시장 단타에서 SL -5%는 큰 폭. 최대 보유기간 7일과 결합해 손실이 누적되지 않는지?
6. **리스크 필터 `maxAboveSma20Pct` 18% 완화**: 강세 추세 종목 포함이 의도지만, 과열 후 급락 위험이 더 높지 않은가? — `currentSignal.strength ≥ 0.65` + OOS 통과로 일부 보완되지만 모니터링 필요.

이상의 포인트 중 명백한 실수가 있으면 지적 부탁드린다.
