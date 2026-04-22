import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { Public } from '@alpha-mind/common';
import {
  ScanCompletedEvent,
  ScanFailedEvent,
  ScheduledScannerService,
} from './scheduled-scanner.service';

/**
 * market-data-service가 발행하는 스캔 결과/실패 이벤트를 수신한다.
 * HTTP 라우트 없이 RMQ 이벤트 핸들러 전용이므로 전역 AuthGuard를 우회한다.
 */
@Public()
@Controller()
export class ScheduledScannerController {
  constructor(
    private readonly scheduledScannerService: ScheduledScannerService,
  ) {}

  @EventPattern('strategy.scan.completed')
  async onScanCompleted(@Payload() event: ScanCompletedEvent): Promise<void> {
    await this.scheduledScannerService.handleScanCompleted(event);
  }

  @EventPattern('strategy.scan.failed')
  async onScanFailed(@Payload() event: ScanFailedEvent): Promise<void> {
    await this.scheduledScannerService.handleScanFailed(event);
  }
}
