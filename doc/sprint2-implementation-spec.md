# Sprint 2 구현 명세서 (Codex 실행용)

> 목적: 단타(1~3일 스윙) 다종목 자동매매에 **부분청산(scale-out)** 과 **R기반 포지션 사이징** 2건을 Codex가 곧바로 구현하도록 정밀 명세.
> 합성 근거: 설계 3안(MVP·정합성·엣지케이스) + 적대적 리뷰(critical 6 / high 5 / medium 등) 병합. 리뷰의 모든 critical/high 이슈를 본 명세에 반영했다.
> 작성 기준 코드: 2026-06-08 master. 모든 라인 인용은 실제 파일 확인 결과.
> 산출 구조는 `doc/sprint1-implementation-spec.md` 와 동일.

---

## 0. Codex 작업 지침 (먼저 읽을 것)

- **레포 구조**: pnpm workspace. `apps/backend`(:3000, KIS·자동매매), `apps/market-data-service`(:3001, 스캔·백테스트), 공용 라이브러리 `libs/strategies`(`@alpha-mind/strategies`), `libs/common`.
- **스택**: NestJS 11, MikroORM 6(PostgreSQL), `@nestjs/axios`(HttpService), Jest.
- **중요 빌드 의존성**: `libs/strategies` 는 **dist 로 소비**된다. 신규 유틸(`scale-out.ts`, `position-sizing.ts`) 추가/수정 후 반드시 `pnpm --filter @alpha-mind/strategies run build` 를 먼저 실행하고 앱을 빌드/테스트할 것. 빌드 누락 시 런타임에 함수 미존재 → 청산 루프 throw → **청산 중단(손실 무한노출)**.
- **검증 명령**(각 작업 후):
  - lint: `pnpm --filter @alpha-mind/backend run lint` / `... @alpha-mind/market-data-service run lint`
  - build: `pnpm --filter @alpha-mind/strategies run build && pnpm -r run build`
  - test: `pnpm --filter @alpha-mind/backend run test` / `... @alpha-mind/market-data-service run test`
- **가드레일**:
  1. 기존 public 메서드 시그니처/엔티티 컬럼 비파괴. 컬럼 추가는 **MikroORM 마이그레이션 필수**(`apps/backend/src/migrations`), `[OptionalProps]` 목록 동시 갱신.
  2. 새 동작은 전부 **config/상수로 토글·튜닝**. 하드코딩 매직넘버 금지. 기본값 = 기존 동작(`SCALE_OUT_ENABLED=false`, `R_SIZING_ENABLED=false`).
  3. **검증 룰(백테스트)과 실전 룰(세션)이 어긋나지 않게** — 이 프로젝트의 핵심 불변식. 부분청산 "줄일 비율 판정"과 R수량 공식은 **단일 공용 함수**만 호출(if 분기 중복 구현 금지).
  4. 각 작업마다 **단위 테스트 추가**. 토글 OFF 회귀 골든테스트 포함.
  5. 로그는 기존 `Logger` 패턴(한국어 메시지)을 따를 것.
- **Fail-safe 원칙**: 신규 유틸(`evaluateScaleOut`/`computeRiskBasedQty`) 호출은 try/catch 로 감싸 함수 누락/예외 시 **기존 전량청산·기존 사이징으로 폴백**한다. 신규 코드 장애가 청산을 멈추면 안 된다.
- **권장 순서**: (1) `libs/strategies` 유틸 + 단위테스트 → build → (2) 마이그레이션 → (3) T1(부분청산) → (4) T2(R사이징). 각 작업 개별 커밋.
- **합성 핵심 결정**(리뷰 recommendedApproach 채택):
  - 상태모델 = `int scaleOutStage` + `int initialQty`(boolean partialTpDone 금지 — 다단 확장 불가/재마이그레이션 비용).
  - 부분청산 비율 기준 = **발동 시점 holdingQty**(initialQty 고정 + min clamp 만으로는 추매 후 과소매도 발생). initialQty 는 진단/추매정책용.
  - 갭 동시돌파 = **평가/캔들당 최대 1티어**(D1 방식)로 양 엔진 통일(누적반환 사양 철회 — 부분체결 회계 단순화).
  - scaleOutStage 증가 시점 = **체결확정 기준**(접수기준 낙관증가 폐기). 동시성은 `sellInFlightSessionIds` 락이 담당.
  - R사이징 equity 출처 = **per-position `session.investmentAmount`**(계좌 `tot_evlu_amt` 금지 — 다종목 총노출 폭증 + 백테스트 재현 불가).
  - 부분 TP 후 잔량(러너)에는 **별도 느슨한 트레일링/본전 파라미터** 적용(미적용 시 부분청산 이점 소멸 — 1순위 선조치).

---

## T1. 부분청산 (scale-out)

### 목표·근거
"짧게 먹고 빠지되 일부는 추세 남기기". TP1(예: +2%)에서 보유의 50% 를 시장가 확정하고, 잔량은 더 느슨한 트레일링으로 추세를 추적한다. 보유 1~7거래일 초단기 스윙의 손익비를 개선한다.

**현 구조의 부분청산 친화성**(확인됨):
- `handleOrderNotification` SELL 경로(L1685-1717)는 이미 부분체결 회계: `sellQty = Math.min(executedQty, holdingQty)`, `holdingQty<=0` 일 때만 risk 리셋(L1693-1707).
- `applyOptimisticSellFill`(L285-303)도 부분차감 지원: `holdingQty = max(0, holdingQty - qty)`, `<=0` 일 때만 리셋(L292-300).
- `kis-order.recordExecutionNotification`(L165-197)은 한 주문에 대해 `appliedQty`/`previousExecutedQty`/`isFullyExecuted` 를 누적하는 부분체결 모델.

→ **체결 반영 회계는 이미 부분청산 호환**. 수술 지점은 (a) `executeSell` 이 항상 `session.holdingQty` 전량 주문(L1546), (b) 매도 직후 무조건 `autoPausePending=true`(L1571) — 이 두 곳뿐.

### 현재 코드 (파일·라인)
- `apps/backend/src/auto-trading/auto-trading.service.ts`
  - `executeSell(session, price, reason)` L1521-1597: `quantity: session.holdingQty`(L1546), `metadata.pauseAfterSell: true`(L1553), `session.autoPausePending = true`(L1571), 옵티미스틱 폴백에서 `applyOptimisticSellFill` + `pauseSessionAfterAutoSell`(L1573-1586).
  - `evaluateAndExecuteSell(session, price)` L1956-2041: 익절 L1981, 손절 L1989, grace 판정 L1999-2002, 본전 L2003-2014(grace 적용), 트레일링 L2015-2026(grace 적용), 최대보유 L2027-2039. 30초 루프와 실시간 트리거의 단일 진입점.
  - `applyOptimisticSellFill` L285-303, `applyOptimisticBuyFill` L263-283, `markPositionRiskOnBuy` L186-199, `resetPositionRisk` L182-184(highestPriceAfterEntry만 리셋).
  - `handleOrderNotification` BUY L1656-1684 / SELL L1685-1731(pause는 L1722-1726: `isFullyExecuted && holdingQty<=0 && meta.pauseAfterSell`).
  - `pauseSessionAfterAutoSell` L1739-1797.
  - `applyBalanceSnapshotToSessions`(잔고 동기화) L835-920: realQty 덮어쓰기 L863-891, `realQty<=0` 리셋 L869-874/L901-905, `autoPausePending && realQty<=0 → PAUSED` L907-911. 스케줄드 클린업 동기화 L990-1057.
  - `checkSellThresholdsForStock` L1917-1949(종목 단위 `priceTriggeredSellCheckInFlight` 락 L1919/L1930).
  - 동시성 락 `sellInFlightSessionIds` L156, add L1530, delete(finally) L1595.
- `apps/market-data-service/src/strategy/backtest.service.ts`
  - `simulate()` L201-527, `closePosition(candle, rawPrice, reason)` L250-286(전량 하드코딩, 끝에 quantity=0 리셋 L282-285).
  - 청산 블록 L298-409: 갭다운손절 L313, 갭상승익절 L320, 갭하락본전 L327, 갭하락트레일링 L337, 일중 stopLoss L364, takeProfit L371, breakeven L378, trailing L385, maxHolding L394.
  - 매수 블록 L427-476(wasFlat L440, qty=floor(buyAmount/fillPrice) L438).
  - 상수 L61-64(`DEFAULT_TRAILING_STOP_TRIGGER_PCT` 등).
- 엔티티: `apps/backend/src/auto-trading/entities/auto-trading-session.entity.ts` `[OptionalProps]` L51-70.
- 타입: `apps/market-data-service/src/strategy/types/backtest.types.ts` `BacktestConfig` L4-49.
- DTO/컨트롤러: `dto/backtest-query.dto.ts`, `strategy.controller.ts` L415-448(`parseNumberOrDefault`/`parseBooleanOptional` 패턴).

### 데이터 모델 + 마이그레이션
`AutoTradingSessionEntity` 에 컬럼 2개 추가(백테스트는 동일 의미를 로컬변수로 보유 → 컬럼 불필요, 정합은 공용 함수가 보장):

```ts
/** 발동 완료한 부분익절(TP) 티어 수. 0=미발동, 1=TP1 완료, ...
 *  evaluateAndExecuteSell 에서 ladder[scaleOutStage] 만 검사. 단조증가, DB가 진실원본(동시성 방어).
 *  포지션 청산(holdingQty→0)·추매 발생 시 0 으로 리셋. */
@Property({ default: 0 })
scaleOutStage: number = 0;

/** 부분청산 비율 산정 기준이 되는 진입 수량 스냅샷(진단·추매정책용).
 *  flat→첫 진입 시 holdingQty 로 set, 추매 시 갱신, 청산 완료 시 0. */
@Property({ default: 0 })
initialQty: number = 0;
```

- `[OptionalProps]`(L51-70)에 `'scaleOutStage' | 'initialQty'` 추가.
- **set 지점**(첫 진입수량 고정): `applyOptimisticBuyFill`(L272 `wasFlat && holdingQty>0` 블록)와 `handleOrderNotification` BUY(L1663 `wasFlat && holdingQty>0`)에서 `session.initialQty = session.holdingQty; session.scaleOutStage = 0;`.
- **추매(add-on) 정책(명문화 — 리뷰 mustFix)**: 추매 체결로 `holdingQty` 증가 시(`!wasFlat` 경로, applyOptimisticBuyFill L276 / notification L1668), `session.initialQty = session.holdingQty;` 로 갱신하고 `session.scaleOutStage = 0;` 으로 리셋(추매 = 새 포지션 사이클로 간주). 부분청산 비율은 **발동 시점 holdingQty 기준**으로 산정하므로 과소매도가 발생하지 않는다.
- **리셋 지점**(holdingQty→0 전부): `applyOptimisticSellFill` L293 블록, `handleOrderNotification` SELL full-close L1693 블록, `applyBalanceSnapshotToSessions` `realQty<=0` 블록 L869-874 **및** L901-905, 스케줄드 클린업 동기화 L999-1003 **및** L1030-1032 — 각각 `session.scaleOutStage = 0; session.initialQty = 0;` 추가. (이 4개 경로는 이미 `resetPositionRisk` 를 호출하므로 `resetPositionRisk` 본체에 두 줄을 추가하는 것도 가능하나, balance sync `realQty>0` 분기에서는 `resetPositionRisk` 가 호출되지 않으므로 안전하다. **`resetPositionRisk` 본체에 추가하는 방식을 권장** — 누락 위험 최소화. 단 이 경우 매도 직전에 호출되지 않음을 확인했다: `executeSell` 은 risk 리셋을 매도에서 호출하지 않음.)

마이그레이션: `apps/backend/src/migrations/Migration20260608000000.ts` (파일명 타임스탬프는 **실제 생성일 기준**, 미래 날짜 금지. `Migration20260430000000.ts` 스타일):
```ts
import { Migration } from '@mikro-orm/migrations';
export class Migration20260608000000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table "auto_trading_sessions"
        add column "scale_out_stage" int not null default 0,
        add column "initial_qty" int not null default 0;
    `);
  }
  override async down(): Promise<void> {
    this.addSql(`
      alter table "auto_trading_sessions"
        drop column "scale_out_stage",
        drop column "initial_qty";
    `);
  }
}
```
> **운영 룰**: down 마이그레이션은 진행 중 부분청산 포지션의 stage 상태를 유실시킨다(잔량 재익절 위험). **롤백은 장 마감 후, 보유 0 확인 후**에만 수행. 배포는 항상 **마이그레이션 선적용 → 앱 배포** 순서. 마이그레이션 누락 상태로 신규 컬럼 SELECT 시 매매 전면 중단.

### 청산 래더 (공용 유틸)
신규 파일 `libs/strategies/src/utils/scale-out.ts`. 청산을 **(a) 풀-스톱 트리거**(손절/최대보유 — 전량 즉시)와 **(b) 테이크-프로핏 래더**(TP1/TP2... — 비율 분할)로 분리하는 순수 함수.

```ts
export interface ScaleOutTier {
  /** 발동 트리거 수익률(%) — avgBuyPrice 대비 */
  triggerPct: number;
  /** 발동 시 "발동 시점 보유수량" 대비 매도 비율(%) */
  sellRatioPct: number;
  tag: string; // 로그/이유 표기 (예: 'TP1')
}
export interface ScaleOutPlan {
  enabled: boolean;        // 기본 false (비파괴)
  tiers: ScaleOutTier[];   // triggerPct 오름차순
}
export interface ScaleOutDecision {
  tier: ScaleOutTier;
  /** 발동 티어 인덱스 → 호출측이 scaleOutStage 를 이 값+1 로 갱신 */
  tierIndex: number;
  nextStage: number;
}
/**
 * 현재 stage 의 다음 티어 1개만 평가(캔들/평가당 최대 1티어 — 갭 동시돌파도 1티어).
 * returnPct >= tiers[stage].triggerPct 면 그 티어를 반환, 아니면 null.
 * enabled=false 또는 stage >= tiers.length → null.
 */
export function evaluateScaleOut(
  plan: ScaleOutPlan,
  stage: number,
  returnPct: number,
): ScaleOutDecision | null;

export const DEFAULT_SCALE_OUT_PLAN: ScaleOutPlan = {
  enabled: false,
  tiers: [{ triggerPct: 2.0, sellRatioPct: 50, tag: 'TP1' }],
};
```
규칙:
- **단조 1티어**: `tiers[stage]` 만 검사. 한 평가/한 캔들에서 여러 티어를 넘어도 최하 미발동 티어 1개만 반환(다음 평가/봉에서 다음 티어). 실전(틱)·백테스트(봉) 비대칭 제거.
- **손절·최대보유는 래더 비적용** — 항상 전량(잔량 보호 최우선).
- `index.ts`(L41 dynamic-tp-sl export 블록 옆)에 `evaluateScaleOut, DEFAULT_SCALE_OUT_PLAN, type ScaleOutPlan/ScaleOutTier/ScaleOutDecision` re-export.

#### evaluateAndExecuteSell 분기 (L1956-2041)
순서는 **손절 → TP 래더 → 익절 폴백 → 본전 → 트레일링 → 최대보유**. 손절을 래더보다 먼저(잔량 보호 우선). 기존 grace 판정(L1999-2002)은 본전/트레일링에만 적용 유지(TP·손절은 절대조건이라 grace 무관 — 기존 동작).

```ts
// (1) 손절: 기존 L1989-1996 무수정 — 전량.
if (returnPct <= session.stopLossPct) { await this.executeSell(...); return true; }

// (2) TP 래더 (신규, SCALE_OUT_ENABLED 일 때만):
if (SCALE_OUT_ENABLED) {
  let dec: ScaleOutDecision | null = null;
  try {
    dec = evaluateScaleOut(this.scaleOutPlan, session.scaleOutStage, returnPct);
  } catch (e) { dec = null; /* fail-safe: 아래 기존 익절로 폴백 */ }
  if (dec) {
    let sellQty = Math.floor(session.holdingQty * dec.tier.sellRatioPct / 100); // 발동 시점 holdingQty 기준
    // 잔량 1주 흡수: 부분매도 후 MIN_REMAINDER_QTY 미만이면 전량으로 승격
    if (session.holdingQty - sellQty < SCALE_OUT_MIN_REMAINDER_QTY) sellQty = session.holdingQty;
    sellQty = Math.min(sellQty, session.holdingQty);
    if (sellQty > 0) {
      const partial = sellQty < session.holdingQty;
      await this.executeSell(session, price,
        `${dec.tier.tag} ${partial ? '부분' : ''}익절 (${returnPct.toFixed(1)}%, ${dec.tier.sellRatioPct}%)`,
        { sellQty, pauseAfterSell: !partial, stage: dec.nextStage });
      return true;
    }
    // sellQty<=0(소량) → 아래 기존 전량 익절로 자연 폴백
  }
}

// (3) 익절 폴백: 기존 L1981-1987 (SCALE_OUT_ENABLED=false 이거나 dec=null/sellQty<=0).
if (returnPct >= session.takeProfitPct) { await this.executeSell(session, price, `자동 익절 (...)`); return true; }

// (4) 본전 / (5) 트레일링 / (6) 최대보유: 아래 "러너 파라미터" 참조.
```

#### 부분 TP 후 잔량(러너) — 별도 느슨한 트레일링/본전 (리뷰 critical, 1순위 선조치)
**문제**: TP1 은 `returnPct >= takeProfitPct`(기본 2.0%)에서 발동 → 그 시점 `peakReturnPct >= 2.0%` 이미 트레일링 트리거(1.8%)·본전 트리거(1.5%)를 모두 충족. 기존 파라미터로 잔량을 관리하면 TP1 직후 1.2% 되돌림(트레일링) 또는 본전선만 와도 잔량이 즉시 전량 회수 → 부분청산 이점 소멸.

**해결**: `scaleOutStage > 0`(부분익절 1회 이상)인 잔량에는 러너 전용 파라미터를 적용. 본전/트레일링 분기(L2003-2026)에서 stage 기반으로 파라미터를 선택:
```ts
const isRunner = SCALE_OUT_ENABLED && session.scaleOutStage > 0;
const trailTrigger  = isRunner ? RUNNER_TRAILING_TRIGGER_PCT  : TRAILING_STOP_TRIGGER_PCT;  // 예 3.5 vs 1.8
const trailGiveback = isRunner ? RUNNER_TRAILING_GIVEBACK_PCT : TRAILING_STOP_GIVEBACK_PCT; // 예 2.5 vs 1.2
const beTrigger     = isRunner ? RUNNER_BREAKEVEN_TRIGGER_PCT : BREAKEVEN_TRIGGER_PCT;       // 예 4.0 vs 1.5
const beFloor       = isRunner ? RUNNER_BREAKEVEN_FLOOR_PCT   : BREAKEVEN_FLOOR_PCT;          // 예 TP1가-α (avg 대비 +1.0% 등) vs 0.0
```
이 분기 선택을 본전/트레일링 두 if 의 트리거/giveback/floor 변수에 반영(상수 직접 참조 → 위 변수 참조로 교체). **추가 상위 익절선(러너 TP)도 둔다**: stage>0 이고 `returnPct >= RUNNER_TP_PCT`(예 5~6%)면 잔량 전량 익절 → 큰 추가 상승 확정(트레일링 되돌림 대기로 인한 미확정 방지, 리뷰 high #5). 이 러너 익절은 (3) 익절 폴백 위(손절 다음, TP래더와 병렬)에 stage>0 조건으로 배치.

> 다단(TP2) 확장은 `scaleOutPlan.tiers` 에 티어를 추가하면 동작한다(stage int 라 비파괴). 이번 스프린트 기본 plan 은 1티어.

### executeSell 부분수량 변경 (L1521-1597)
**비파괴 확장** — 4번째 옵셔널 인자 추가. 기존 호출처(전량 경로)는 인자 없이 그대로 동작.
```ts
private async executeSell(
  session: AutoTradingSessionEntity,
  price: number,
  reason: string,
  opts?: { sellQty?: number; pauseAfterSell?: boolean; stage?: number },
)
```
변경점(리뷰 critical: 세 지점 + 폴백·통보 양 경로 전부 가드):
1. **수량**: `const sellQty = Math.min(opts?.sellQty ?? session.holdingQty, session.holdingQty);` → L1546 `quantity: sellQty`. 진입 가드 추가 `if (sellQty <= 0) return;` (L1526 `holdingQty<=0` 가드 아래). 로그(L1538, L1568)도 `sellQty` 사용.
2. **pause 토글**: `const pause = opts?.pauseAfterSell ?? true;`
   - L1553 metadata `pauseAfterSell: pause`. 추가로 `partial: !pause`, `stage: opts?.stage` 를 metadata 에 함께 실음.
   - L1571 `session.autoPausePending = true;` → `if (pause) session.autoPausePending = true;`
   - **옵티미스틱 폴백**(L1573-1586): `applyOptimisticSellFill(session, price, sellQty)` 는 부분차감 지원(무수정). `pauseSessionAfterAutoSell` 호출(L1586)은 `if (pause) await this.pauseSessionAfterAutoSell(...)` 로 가드. **부분매도(pause=false)면 호출 안 함** — 호출하면 stillHeld 분기(L1752)로 잔량 정상인데 "재감시 전환" 로그 오작동.
3. **scaleOutStage 증가 = 체결확정 기준**(리뷰 critical #3 — 접수기준 낙관증가 폐기):
   - **통보 경로**(`handleOrderNotification` SELL): full-close 가 아닌 부분체결로 `holdingQty` 가 감소 확정된 시점에 stage 갱신. L1685-1717 블록에 `meta.partial`(또는 `meta.stage`)가 있고 `holdingQty>0`(부분 잔존) 또는 `isFullyExecuted` 인 경우 `if (meta.stage != null) session.scaleOutStage = meta.stage;` 한 줄 추가(L1690 totalSells 증가 옆, wasFirstExecution 기준 1회). full-close 리셋(L1693) 시에는 `scaleOutStage=0` 이 우선.
   - **옵티미스틱 폴백 경로**: `applyOptimisticSellFill` 직후(L1576 flush 전)에 `if (opts?.stage != null && session.holdingQty > 0) session.scaleOutStage = opts.stage;`.
   - 동일 tick 이중발동은 `sellInFlightSessionIds` 락(L1528, finally 해제 L1595)이 차단. 락 해제 후 다음 tick 재발동은 stage 단조증가가 차단(이중 방어). **접수 직후 낙관 증가는 하지 않는다** — 부분체결 방치(접수는 됐으나 잔량 미체결) 시 stage 소진+잔량 영구 미청산을 방지.
4. **주문 거부/리젝트 롤백**: 접수 실패(`rt_cd !== '0'` L1560) 시 stage 미증가(체결확정 기준이므로 자동). 리젝트 통보(L1602-1617)는 stage 를 건드리지 않음(증가하지 않았으므로 롤백 불필요).

### 동시성 · autoPausePending 처리
- **진입점 단일화**: 30초 루프와 실시간 트리거 모두 `evaluateAndExecuteSell → executeSell`. `sellInFlightSessionIds`(세션락) + `priceTriggeredSellCheckInFlight`(종목락 L1919) 그대로 유효.
- **부분매도는 세션을 멈추지 않는다**: `pause=false` → `autoPausePending` 미설정 → 잔량 계속 감시. `pauseSessionAfterAutoSell` 미호출. 재발동 방지는 `scaleOutStage` 가 담당.
- **잔고 동기화 상호작용**(리뷰 critical/medium):
  - `applyBalanceSnapshotToSessions` `realQty>0` 분기(L863-891, L996-1057)에서 holdingQty 를 KIS 실잔고로 덮어쓸 때 **`scaleOutStage`/`initialQty` 는 절대 건드리지 않음**(명시적 보존 — KIS 잔고엔 이 두 필드가 없음). `realQty<=0` full-flat 분기에서만 0 리셋(데이터모델 절 참조).
  - **부분매도 접수~체결 지연 중 덮어쓰기 보류**: `sellInFlightSessionIds` 에 든 세션, 또는 `getOpenOrderMap`(L305-)에 미체결 주문이 있는 종목은 동기화에서 holdingQty 덮어쓰기를 건너뛴다(접수 후 통보 전 KIS 잔고가 매도 전 값으로 복원되어 잔량 계산 오차 방지). `applyBalanceSnapshotToSessions` 루프(L855)에 `if (this.sellInFlightSessionIds.has(session.id)) continue;` 가드 추가.

### 백테스트 simulate 정합 (backtest.service.ts L201-527)
- **부분청산 헬퍼 신설**: `closePosition`(L250-286) 곁에 `reducePosition(candle, rawPrice, reason, sellQty)` 추가 — 동일 비용구조(slippage L255, commission L257, sellTax L258, pnl L261)로 sellQty 만큼 부분 반영, `quantity -= sellQty`, `avgBuyPrice`/`entryIndex`/`highestPriceAfterEntry` **보존**. sellQty 가 전량이면 `closePosition` 위임. trades push 의 quantity 도 sellQty.
- **로컬 상태 추가**: `let scaleOutStage = 0; let initialQtyAtEntry = 0;`(L211 인근). 매수 wasFlat(L440) 시 `initialQtyAtEntry = qty; scaleOutStage = 0;`. add-on(L431 allowAddOnBuy 경로, `!wasFlat`)에서 `initialQtyAtEntry = quantity; scaleOutStage = 0;`(실전 추매 정책과 동일).
- **래더 적용 위치**(실전 순서와 동일: 손절 → scaleOut → 익절 → 본전 → 트레일링 → 최대보유):
  - 갭상승 분기(L320 `candle.open >= takeProfitPrice`): 손절(L313) 다음에 scaleOut 평가 삽입. `returnPct_open = (candle.open - avgBuyPrice)/avgBuyPrice*100` 로 `evaluateScaleOut(plan, scaleOutStage, returnPct_open)`. 발동 시 갭 시가에 `reducePosition(..., floor(quantity*tier.sellRatioPct/100))`, `scaleOutStage = dec.nextStage`.
  - 일중 분기(L348~): `takeProfitHit`(L348) 전에 scaleOut 평가. **기준가 명문화**(리뷰 high #6): 갭상승=시가(candle.open), 일중=히트가(takeProfitPrice). `evaluateScaleOut` 입력 returnPct 는 이 기준가로 산정(실전=현재 틱가와 동일 규칙).
- **부분익절 후 같은 캔들 처리**(리뷰 medium): 부분익절 발동 캔들은 `exitedThisCandle` 를 **유지(true)** 하되, **손절(stopLoss)만은 예외적으로 잔량에 대해 계속 평가**해 전량 청산 가능하게 한다(실전 틱 단위 즉시 손절을 백테스트가 보수적으로 반영). 본전/트레일링은 다음 봉으로 보류. 즉 부분익절 직후 같은 봉 손절선 히트(`candle.low <= stopLossPrice`) 시 잔량 `closePosition`.
- **러너 파라미터 반영**(정합 필수): `scaleOutStage > 0` 인 잔량의 트레일링(L337/L361)·본전(L327/L358)·러너TP에 실전과 **동일한 RUNNER_* 파라미터** 적용. 미반영 시 백테스트는 좋고 실전은 즉시 회수되는 괴리.
- **BacktestConfig 확장**(L4-49): `scaleOut?: ScaleOutPlan;`(옵셔널, 미지정 OFF) + 러너 파라미터 `runnerTrailingTriggerPct?`/`runnerTrailingGivebackPct?`/`runnerBreakevenTriggerPct?`/`runnerBreakevenFloorPct?`/`runnerTakeProfitPct?`. simulate 상단(L237-244 패턴)에서 `?? DEFAULT_*` 흡수.
- **DTO/컨트롤러 패스스루**(L415-448 패턴): `scaleOutEnabled`/`scaleOutTp1TriggerPct`/`scaleOutTp1SellRatioPct` 및 러너 파라미터를 `parseBooleanOptional`/`parseNumberOrDefault` 로 파싱해 `scaleOut` plan 으로 조립. **스캔/그리드서치 경로에서도 동일 소스(plan)를 주입**해야 검증=실전(누락 시 검증 OFF/실전 ON 괴리).

### config (전부 토글, 하드코딩 금지)
backend 상수블록(`auto-trading.service.ts` L78-104)에 추가(추후 ConfigService 승격 가능, Sprint1 패턴):
```ts
const SCALE_OUT_ENABLED = false;                 // 기본 off = 기존 전량익절
const SCALE_OUT_TP1_TRIGGER_PCT = 2.0;           // TP1 트리거(미설정 시 session.takeProfitPct 사용 권장)
const SCALE_OUT_TP1_SELL_RATIO_PCT = 50;         // TP1 매도 비율
const SCALE_OUT_MIN_REMAINDER_QTY = 1;           // 부분매도 후 잔량 이 미만이면 전량 승격
// 러너(부분익절 후 잔량) 전용 — 더 느슨하게
const RUNNER_TRAILING_TRIGGER_PCT = 3.5;
const RUNNER_TRAILING_GIVEBACK_PCT = 2.5;
const RUNNER_BREAKEVEN_TRIGGER_PCT = 4.0;
const RUNNER_BREAKEVEN_FLOOR_PCT = 1.0;           // 진입가 대비 +1.0%(TP1가 근처)
const RUNNER_TAKE_PROFIT_PCT = 6.0;               // 잔량 상위 익절선
```
`scaleOutPlan` 은 위 상수로 조립한 `ScaleOutPlan` 멤버(또는 `DEFAULT_SCALE_OUT_PLAN` 에 enabled 만 덮어쓰기). backtest 측은 `BacktestConfig.scaleOut` + `DEFAULT_*` 상수(backtest.service.ts L61-64 옆): `DEFAULT_SCALE_OUT_*`, `DEFAULT_RUNNER_*`.

### 엣지케이스
- **floor 후 sellQty=0**(저가·소수량, 예 holdingQty=1, 50%→0): `if (sellQty<=0)` 가드로 부분 스킵 → 기존 전량 익절 폴백(잔량 방치 금지).
- **sellQty == holdingQty**(비율이 잔량 전량): `partial=false` → `pause=true`, 전량 익절 경로, stage 도 증가하나 다음 평가에서 holdingQty=0 이라 무영향.
- **잔량 1주**: `holdingQty - sellQty < SCALE_OUT_MIN_REMAINDER_QTY` → sellQty 를 holdingQty 로 승격(비경제 잔량 방지), pause=true 전환.
- **이중매도(동일 tick)**: `sellInFlightSessionIds` 락이 접수~체결 사이 차단. 부분매도는 pause=false 라 락 해제 후 다음 tick 재진입 가능 → `scaleOutStage` 증가가 동일 티어 재발동 차단(직교 이중방어).
- **부분체결(주문 100주 중 60주만 체결)**: `handleOrderNotification` SELL(L1685) 기존 가드(`sellQty=min`, `holdingQty>0` 면 미리셋·미pause)로 정합. stage 는 체결확정 기준이라 부분체결 방치 시에도 의도 비율 미달이면 다음 평가에서 동일/다음 티어 재평가 가능.
- **추매 후 부분익절**: 추매 시 initialQty 갱신 + scaleOutStage=0 리셋. 비율은 발동 시점 holdingQty 기준이라 과소매도 없음.
- **손절선 하향 이탈(부분 후)**: 손절 분기(L1989, 무수정)가 잔량 전량 매도 — 정상.
- **grace period 중 TP 부분익절**: TP 는 returnPct 절대조건(기존도 grace 안 봄) → 발동 OK. 본전/트레일링만 grace 적용 보존.
- **마지막 티어 sellRatioPct=100 plan**: 마지막 부분익절이 전량 매도 → pause=true 경로로 폴백(세션 정상 종료).
- **balance sync 잔량 보정**: realQty>0 분기에서 stage/initialQty 보존, realQty<=0 에서만 0 리셋(불일치 방지). sellInFlight 중 덮어쓰기 보류.
- **백테스트 useNextOpenForBuy=false(테스트모드)**: 청산 블록은 candle 기준이라 actionPrice 분기와 무관 — 부분청산 동작 동일.
- **갭다운(부분익절 전)**: stage=0 상태 갭다운 손절(L313) 전량. 부분익절 후 잔량 보유 중 다음날 갭다운이면 잔량 전량 손절.

### 수용 기준
- [ ] `SCALE_OUT_ENABLED=false` 일 때 기존 매매/백테스트 결과 **회귀 0**(골든 스냅샷 테스트로 고정).
- [ ] ON: TP1 도달 시 보유의 50% 시장가 매도, 세션 ACTIVE 유지(`autoPausePending=false`), `scaleOutStage=1`, `pauseSessionAfterAutoSell` 미호출.
- [ ] 부분매도 metadata 에 `pauseAfterSell:false`, `partial:true`, `stage` 가 실리고, 통보/폴백 양 경로 모두 세션 미정지 확인.
- [ ] 잔량은 RUNNER_* 느슨한 트레일링/본전/러너TP 로 청산(기존 1.8/1.2/1.5 가 아님). 백테스트도 동일 파라미터 사용.
- [ ] `scaleOutStage` 는 체결확정 시점에만 증가(접수 직후 증가 안 함). 미체결 잔량 시 stage 비소진 확인.
- [ ] 동일 종목 단일 봉/tick 에서 TP1 중복 매도 없음(stage + 락).
- [ ] `syncSessionsWithBalance` 가 realQty>0 분기에서 stage/initialQty 보존, sellInFlight 세션은 덮어쓰기 보류.
- [ ] 추매 시 initialQty 갱신 + stage=0 리셋, 부분익절 비율은 발동 시점 holdingQty 기준(과소매도 없음).
- [ ] simulate 와 session 이 동일 `evaluateScaleOut` 호출(분기 중복 구현 없음).

### 테스트
- `scale-out.spec.ts`(libs): stage 단조전이, enabled=false→null, stage>=tiers.length→null, 갭 동시돌파에서도 1티어만 반환, returnPct 경계.
- `auto-trading.service` spec: (a) 부분 TP1 후 autoPausePending=false·scaleOutStage 증가, (b) executeSell 3인자 전량 경로 회귀(기존 5개 호출처가 인자 없이 동작), (c) 옵티미스틱 폴백에서 pause 미호출, (d) 통보 부분체결 시 stage 체결확정 증가, (e) 추매 시 initialQty 갱신/stage 리셋, (f) balance sync stage/initialQty 보존.
- `backtest.service` spec: scaleOut 미지정 시 기존 결과 골든 동일, plan 지정 시 reducePosition 비용구조 == closePosition, 부분익절 캔들 손절 예외 평가, 러너 파라미터 적용.
- **정합 대조 테스트**: 동일 (plan, returnPct 시퀀스)에서 backtest reducePosition 수량비 == session 부분매도 수량비(`floor(holdingQty*ratio)` 동일 식).

---

## T2. R기반 포지션 사이징

### 목표·근거
종목별 손실노출 균등화. `qty = floor((equity × riskPct%) / (진입가 − 손절가))`. 손절폭이 큰(변동성 큰) 종목은 적게, 작은 종목은 많이 매수해 1트레이드 손실이 equity 의 riskPct% 로 일정해진다.

### 공식 · equity 출처 · 기존 ATR역가중과의 관계
- **공식**: `stopLossPrice = entryPrice × (1 + stopLossPct/100)`(음수 stopLossPct, dynamic-tp-sl.ts 산출값과 동일). `perShareRisk = entryPrice − stopLossPrice = entryPrice × |stopLossPct|/100`. `riskBudget = equity × riskPct/100`. `qty = floor(riskBudget / perShareRisk)`.
- **equity 출처 = per-position `session.investmentAmount`**(리뷰 mustFix — 계좌 `tot_evlu_amt` 금지):
  - 계좌 잔고 기반은 다종목 동시운용 시 총노출 = equity×riskPct×N 으로 폭증(글로벌 캡 미설계). 또 백테스트 simulate 는 종목별 단일 포지션·`config.investmentAmount` 기준이라 계좌기준 R 을 재현 불가 → 검증-실전 정합 붕괴.
  - `R_EQUITY_SOURCE: 'session'` 고정. `'account'` 분기는 토글 자리만 남기고 이번 스프린트 미구현(포트폴리오 레벨 R 글로벌 캡과 함께 별도 스프린트).
- **ATR역가중과의 관계**(직교): `scheduled-scanner.computeVolatilityWeightedInvestments`(L604-627)는 **종목별 예산(investmentAmount) 배분** 단계. R사이징은 그 예산 "안에서" 손절폭 기반 **수량**을 정하는 별개 레이어. R off 면 기존 `ratioPct × investmentAmount` 그대로.
  - **이중 변동성 보정 주의**: ATR역가중(변동성↑→예산↓)과 R(손절폭↑→수량↓, 손절폭은 ATR동적SL 로 변동성 비례)이 같은 방향 → 변동성 큰 종목 과소편입 위험. 완화: `R_SIZING_ENABLED` 켤 때 `VOL_WEIGHT` clamp 를 `[0.8, 1.25]` 로 좁히는 토글(`R_SIZING_OVERRIDES_VOL_WEIGHT`, 기본 false). 기본 R off 라 무영향.

### 공용 유틸
신규 파일 `libs/strategies/src/utils/position-sizing.ts`:
```ts
export interface RiskSizingOptions {
  riskPct: number;          // equity 대비 1트레이드 손실노출 % (기본 0.5)
  budgetCapAmount: number;  // per-position 예산 상한(=remainingBudget). 초과 금지
  minQty?: number;          // 기본 1
}
/**
 * qty = floor((equity*riskPct/100)/perShareRisk), budgetCapAmount/entryPrice 로 clamp.
 * perShareRisk<=0 || !isFinite → null(호출측이 매수 스킵 또는 정책 폴백 결정).
 */
export function computeRiskBasedQty(
  equity: number,
  entryPrice: number,
  stopLossPct: number,      // 음수(%)
  opts: RiskSizingOptions,
): { qty: number; perShareRisk: number } | null;
```
표준 가드(리뷰 medium — 세 설계 캡 정의 통일):
- `perShareRisk = entryPrice * |stopLossPct|/100`. `perShareRisk <= 0 || !isFinite(perShareRisk)` → `null`(stopLossPct=0/양수 설정오류 방어).
- `qty = min(floor(riskBudget / perShareRisk), floor(budgetCapAmount / entryPrice))` — **단일 캡 = remainingBudget**.
- `qty < (opts.minQty ?? 1)` → `qty = 0`. `qty <= 0` 면 **매수 스킵**(폴백 금지 — 폴백하면 R 의도와 무관한 과대수량 유입).
- `index.ts` 에 `computeRiskBasedQty, type RiskSizingOptions` re-export.

### 통합 지점 (executeBuy 수량 산정)
- `executeBuy`(L1357-1440) qty 산정(L1398 `Math.floor(tradeAmount/price)`)을 토글 분기. **첫 진입(`!isAddOn`)에서만 R 적용**, 추매(isAddOn)는 기존 ratioPct 유지(R분모 혼선·누적노출 과대 방지):
```ts
let qty: number;
if (R_SIZING_ENABLED && !isAddOn) {
  let r: { qty: number } | null = null;
  try {
    r = computeRiskBasedQty(
      Number(session.investmentAmount),       // equity = per-position 예산
      price, session.stopLossPct,
      { riskPct: R_RISK_PCT, budgetCapAmount: remainingBudget }, // 기존 L1386 가드 재사용
    );
  } catch (e) { r = null; } // fail-safe → 기존 경로
  if (r) qty = r.qty;
  else qty = Math.floor(tradeAmount / price); // perShareRisk<=0(설정오류) 등 → 기존 비율식 폴백
} else {
  qty = Math.floor(tradeAmount / price);      // 기존
}
if (qty <= 0) return; // 기존 L1399
```
- **기존 remainingBudget 가드(L1383-1396) 유지** — R수량이라도 `qty*price` 가 잔여예산 초과 못 함(budgetCapAmount=remainingBudget 로 이미 clamp, 이중 안전망).
- `executeImmediateBuy`(L1446-1474) qty 산정(L1467)도 동일 토글 분기(첫 진입이므로 항상 R 적용 가능). budgetCapAmount = `tradeAmount`(L1465-1466).
- **stopLossPct 출처**: `session.stopLossPct`(ATR 동적 TP/SL 로 세션 생성 시 산정된 값). ATR maxSL(5%) 클램프 종목은 perShareRisk 가 작아져 R수량 과대 → budgetCapAmount 캡으로 제한.

### 백테스트 simulate 정합 (매수 수량)
- 매수 블록(L438 `qty = floor(buyAmount/fillPrice)`)을 첫 진입(wasFlat L440) 한정 R경로로 교체:
```ts
const r = config.rSizing?.enabled
  ? computeRiskBasedQty(config.investmentAmount, fillPrice, config.autoStopLossPct,
      { riskPct: config.rSizing.riskPct, budgetCapAmount: buyAmount })
  : null;
const qty = r ? Math.min(r.qty, Math.floor(buyAmount / fillPrice))
              : Math.floor(buyAmount / fillPrice);
```
- equity = `config.investmentAmount`(세션과 동일 의미). cash 가드(`buyAmount = min(tradeAmount, cash/(1+comm))` L436) 유지(현금 음수 방지).
- **BacktestConfig 확장**: `rSizing?: { enabled: boolean; riskPct: number }`(미지정 OFF). DTO/컨트롤러 패스스루(`rSizingEnabled`/`rRiskPct`, L415-448 패턴).

### config
backend 상수블록(L78-104):
```ts
const R_SIZING_ENABLED = false;            // 기본 off = 기존 비율식
const R_RISK_PCT = 0.5;                    // equity 대비 트레이드 손실노출 %
const R_EQUITY_SOURCE = 'session';         // 'session' | 'account'(미구현 자리)
const R_SIZING_OVERRIDES_VOL_WEIGHT = false; // true면 R 켤 때 VOL_WEIGHT clamp 축소
```
backtest 측 `DEFAULT_R_SIZING_ENABLED=false`, `DEFAULT_R_RISK_PCT=0.5`.

### 엣지케이스
- **stopLossPct = 0 또는 양수**(설정오류/ATR 경계): perShareRisk<=0 → null → 기존 비율식 폴백(0division/Infinity 방지).
- **고가주 + 작은 riskBudget(qty=0)**: 매수 스킵(폴백 금지). 기존 `qty<=0 return` 동작.
- **R수량 > 잔여예산**: budgetCapAmount(remainingBudget) 로 clamp. 예산 우회 금지.
- **ATR maxSL 클램프 종목**: perShareRisk 작아 R수량 과대 → budgetCapAmount 캡 제한.
- **백테스트 cash 부족**: `min(r.qty, floor(buyAmount/fillPrice))` 로 현금 음수 방지.
- **추매**: R 미적용(첫 진입만), 기존 addOnBuyRatioPct 유지.
- **ATR역가중 + R 동시 ON**: 이중축소 → `R_SIZING_OVERRIDES_VOL_WEIGHT` 로 명시 제어, 동시 운용 전 백테스트 필수.

### 수용 기준
- [ ] `R_SIZING_ENABLED=false` 일 때 기존 수량/백테스트 결과 **회귀 0**.
- [ ] ON 첫 진입 qty = `floor(investmentAmount × R_RISK_PCT% / (price × |stopLossPct|%))`, remainingBudget 캡 준수.
- [ ] equity 출처 = `session.investmentAmount`(계좌 잔고 조회 없음).
- [ ] perShareRisk<=0 시 매수 스킵/폴백이 의도대로(과대수량 유입 없음).
- [ ] 추매에는 R 미적용(첫 진입만).
- [ ] simulate 와 session 이 동일 `computeRiskBasedQty` 호출.

### 테스트
- `position-sizing.spec.ts`(libs): 정상 공식, perShareRisk<=0→null, budgetCap clamp, qty<minQty→0, !isFinite 방어.
- `auto-trading.service` spec: R-ON 첫 진입 수량 공식 검증, 추매 R 미적용, remainingBudget 초과 clamp, R-OFF 회귀.
- `backtest.service` spec: rSizing 미지정 회귀 동일, 지정 시 수량 공식 == 실전, cash 가드.

---

## 8. 작업 범위 밖 (이번 Sprint 제외)
- **계좌 잔고 기반 R**(`R_EQUITY_SOURCE='account'`) + 포트폴리오 레벨 R 글로벌 캡(Σ riskBudget ≤ equity×maxPortfolioRiskPct) — 별도 스프린트.
- **다단 TP(TP2 이상)** 운용 튜닝 — 본 구현은 stage int 로 확장 가능하나 기본 plan 은 1티어.
- 시장 레짐 스케일러, 상관/클러스터 캡, 롤링 walk-forward, VI/NXT 분기 주문처리 → Sprint 3~4.
- 지표 의미 변화 정리: 부분익절로 totalSells/totalTrades/winRate 가 포지션당 다거래로 카운트되어 winRate 가 인위적으로 부풀 수 있음. 본 스프린트는 `BacktestTrade` 에 옵셔널 `partial?: boolean` 필드(비파괴)만 추가하고, 지표 재정의(포지션 단위 vs 체결 단위)는 문서 주석으로 명시 — 정식 분리는 후속.

## 9. 완료 정의 (DoD)
- [ ] T1·T2 각 수용 기준 충족 + 단위 테스트 통과 + 토글 OFF 회귀 골든테스트 통과.
- [ ] `libs/strategies` 빌드 선행 후 `pnpm --filter @alpha-mind/strategies run build && pnpm -r run build` 성공.
- [ ] `pnpm -r run lint` 통과.
- [ ] 마이그레이션 생성·적용(타임스탬프 실제 생성일), `[OptionalProps]` 갱신.
- [ ] 신규 유틸 호출 try/catch fail-safe(레거시 폴백) 적용 확인.
- [ ] 각 작업 개별 커밋(메시지에 T번호·요약), `.env`/상수 토글 기본값 OFF 확인.
