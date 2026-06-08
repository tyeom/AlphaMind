export interface ScaleOutTier {
  /** 발동 트리거 수익률(%) - avgBuyPrice 대비 */
  triggerPct: number;
  /** 발동 시점 보유수량 대비 매도 비율(%) */
  sellRatioPct: number;
  /** 로그와 청산 사유에 남길 티어 태그 */
  tag: string;
}

export interface ScaleOutPlan {
  /** 기본 false: 기존 전량 익절 경로를 보존한다. */
  enabled: boolean;
  /** triggerPct 오름차순 래더 */
  tiers: ScaleOutTier[];
}

export interface ScaleOutDecision {
  tier: ScaleOutTier;
  /** 호출측이 stage 정합성을 확인할 수 있는 발동 티어 인덱스 */
  tierIndex: number;
  /** 체결 확정 후 저장할 다음 stage */
  nextStage: number;
}

export const DEFAULT_SCALE_OUT_PLAN: ScaleOutPlan = {
  enabled: false,
  tiers: [{ triggerPct: 2.0, sellRatioPct: 50, tag: 'TP1' }],
};

export function evaluateScaleOut(
  plan: ScaleOutPlan,
  stage: number,
  returnPct: number,
): ScaleOutDecision | null {
  if (
    !plan.enabled ||
    !Number.isFinite(stage) ||
    !Number.isInteger(stage) ||
    stage < 0 ||
    !Number.isFinite(returnPct)
  ) {
    return null;
  }

  const tier = plan.tiers[stage];
  if (!tier || !Number.isFinite(tier.triggerPct)) {
    return null;
  }

  // 한 평가에서는 다음 미발동 티어 하나만 검사해 갭 동시돌파도 1티어로 제한한다.
  if (returnPct < tier.triggerPct) {
    return null;
  }

  return {
    tier,
    tierIndex: stage,
    nextStage: stage + 1,
  };
}
