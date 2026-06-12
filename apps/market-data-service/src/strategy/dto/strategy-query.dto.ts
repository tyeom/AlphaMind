import {
  DayTradingVariant,
  MeanReversionVariant,
  ScalpingVariant,
} from '@alpha-mind/strategies';

export interface DayTradingQueryDto {
  variant?: DayTradingVariant;
  kFactor?: string;
  lookbackPeriod?: string;
  shortPeriod?: string;
  longPeriod?: string;
  volumeMultiplier?: string;
  volumePeriod?: string;
  consecutiveUpCandles?: string;
  rsiOverbought?: string;
}

export interface MeanReversionQueryDto {
  variant?: MeanReversionVariant;
  rsiPeriod?: string;
  oversold?: string;
  overbought?: string;
  bbPeriod?: string;
  stdMultiplier?: string;
  spacingPct?: string;
  gridLevels?: string;
}

export interface InfinityBotQueryDto {
  totalAmount?: string;
  maxRounds?: string;
  roundPct?: string;
  dipTriggerPct?: string;
  takeProfitPct?: string;
}

export interface CandlePatternQueryDto {
  minPatternStrength?: string;
  useVolumeConfirmation?: string;
  useTrendConfirmation?: string;
  trendPeriod?: string;
}

export interface ScalpingQueryDto {
  variant?: ScalpingVariant;
  rsiPeriod?: string;
  rsiOversold?: string;
  minRvol?: string;
  pullbackMinPct?: string;
  pullbackMaxPct?: string;
}
