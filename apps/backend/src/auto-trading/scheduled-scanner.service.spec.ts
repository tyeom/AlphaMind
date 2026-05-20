import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { EntityManager } from '@mikro-orm/postgresql';
import { of, throwError } from 'rxjs';
import {
  ScanCompletedEvent,
  ScheduledScannerService,
} from './scheduled-scanner.service';

describe('ScheduledScannerService', () => {
  const createService = () => {
    const execute = jest.fn();
    const em = {
      getConnection: () => ({ execute }),
      find: jest.fn(),
    } as unknown as EntityManager & {
      find: jest.Mock;
    };
    const configService = {
      get: jest.fn().mockReturnValue(1),
    } as unknown as ConfigService & { get: jest.Mock };
    const autoTradingService = {
      removeStaleScheduledScanSessions: jest
        .fn()
        .mockResolvedValue({ skippedDueToBalanceSyncFailure: false }),
      updateSession: jest.fn(),
      resumeSession: jest.fn(),
      startSessions: jest.fn().mockResolvedValue([]),
    };
    const notificationService = {
      create: jest.fn(),
    };
    const marketDataClient = {
      emit: jest.fn(),
      send: jest.fn().mockReturnValue(
        of({
          tpPct: 2.5,
          slPct: -2,
          source: 'default',
        }),
      ),
    } as unknown as ClientProxy & { emit: jest.Mock; send: jest.Mock };

    const service = new ScheduledScannerService(
      configService,
      em,
      autoTradingService as any,
      notificationService as any,
      marketDataClient,
    );

    return {
      service,
      execute,
      em,
      configService,
      autoTradingService,
      notificationService,
      marketDataClient,
    };
  };

  it('releases the scan lock when request publish fails', async () => {
    const { service, execute, em, marketDataClient } = createService();
    execute
      .mockResolvedValueOnce([{ job_name: 'scheduled-ai-scan' }])
      .mockResolvedValueOnce([]);
    (em.find as jest.Mock).mockResolvedValue([]);
    marketDataClient.emit.mockReturnValue(
      throwError(() => new Error('publish failed')),
    );

    await expect(service.triggerScan('manual')).rejects.toThrow(
      'publish failed',
    );

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[0][0]).toContain(
      'insert into scheduled_job_locks',
    );
    expect(execute.mock.calls[1][0]).toContain('update scheduled_job_locks');
    expect(execute.mock.calls[1][0]).toContain('"locked_until" = now()');
    expect(execute.mock.calls[1][0]).toContain('released:');
  });

  it('claims a completed event only once before applying scan results', async () => {
    const { service, execute, em } = createService();
    const event: ScanCompletedEvent = {
      userId: 1,
      requestId: 'req-1',
      response: {
        scannedStocks: 0,
        eligibleStocks: 0,
        excludedStocks: 0,
        results: [],
      },
    };

    execute
      .mockResolvedValueOnce([{ job_name: 'scheduled-ai-scan' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    (em.find as jest.Mock).mockResolvedValue([]);

    await service.handleScanCompleted(event);
    await service.handleScanCompleted(event);

    expect(em.find).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[0][0]).toContain('greatest(');
    expect(execute.mock.calls[2][0]).toContain(
      `and "owner" = '${event.requestId}'`,
    );
  });

  it('uses scan-validated TP/SL values when starting sessions', async () => {
    const { service, execute, em, autoTradingService } = createService();
    const event: ScanCompletedEvent = {
      userId: 1,
      requestId: 'req-2',
      response: {
        scannedStocks: 1,
        eligibleStocks: 1,
        excludedStocks: 0,
        results: [
          {
            stockCode: '005930',
            stockName: '삼성전자',
            volatilityPct: 3.2,
            autoTakeProfitPct: 4.8,
            autoStopLossPct: -4.16,
            bestStrategy: {
              strategyId: 'day-trading',
              strategyName: '일간 모멘텀 통합 전략',
            },
            currentSignal: {
              direction: 'BUY',
              strength: 0.8,
              reason: 'fresh buy',
            },
          },
        ],
      },
    };

    execute.mockResolvedValueOnce([{ job_name: 'scheduled-ai-scan' }]);
    (em.find as jest.Mock).mockResolvedValue([]);
    autoTradingService.startSessions.mockResolvedValue([
      { stockCode: '005930' },
    ]);

    await service.handleScanCompleted(event);

    expect(autoTradingService.startSessions).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        sessions: [
          expect.objectContaining({
            stockCode: '005930',
            takeProfitPct: 4.8,
            stopLossPct: -4.16,
          }),
        ],
      }),
    );
  });
});
