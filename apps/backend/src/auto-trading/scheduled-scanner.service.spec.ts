import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { EntityManager } from '@mikro-orm/postgresql';
import { throwError } from 'rxjs';
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
    } as unknown as ClientProxy & { emit: jest.Mock };

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
});
