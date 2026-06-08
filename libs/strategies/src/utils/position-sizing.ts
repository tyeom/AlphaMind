export interface RiskSizingOptions {
  /** equity 대비 1트레이드 손실노출 비율(%) */
  riskPct: number;
  /** 포지션 예산 상한. R 수량도 이 금액을 넘지 않는다. */
  budgetCapAmount: number;
  /** 최소 주문 수량 */
  minQty?: number;
}

export interface RiskSizingResult {
  qty: number;
  perShareRisk: number;
}

export function computeRiskBasedQty(
  equity: number,
  entryPrice: number,
  stopLossPct: number,
  opts: RiskSizingOptions,
): RiskSizingResult | null {
  const perShareRisk = entryPrice * (Math.abs(stopLossPct) / 100);
  if (
    !Number.isFinite(equity) ||
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(stopLossPct) ||
    !Number.isFinite(opts.riskPct) ||
    !Number.isFinite(opts.budgetCapAmount) ||
    equity <= 0 ||
    entryPrice <= 0 ||
    stopLossPct >= 0 ||
    perShareRisk <= 0 ||
    !Number.isFinite(perShareRisk)
  ) {
    return null;
  }

  const riskBudget = equity * (opts.riskPct / 100);
  const riskQty = Math.floor(riskBudget / perShareRisk);
  const budgetCapQty = Math.floor(opts.budgetCapAmount / entryPrice);
  const minQty = opts.minQty ?? 1;
  const qty = Math.min(riskQty, budgetCapQty);

  // 최소 수량 미만이면 호출측이 기존 qty<=0 정책으로 매수를 건너뛰게 한다.
  return {
    qty: qty < minQty ? 0 : qty,
    perShareRisk,
  };
}
