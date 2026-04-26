import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { AiMeetingResultService } from './ai-meeting-result.service';
import { User } from '../decorator/user.decorator';

@Controller('ai-meeting-results')
export class AiMeetingResultController {
  constructor(private readonly service: AiMeetingResultService) {}

  @Post()
  upsert(
    @User() user: any,
    @Body()
    body: {
      scores: {
        stockCode: string;
        stockName: string;
        score: number;
        reasoning: string;
        data: Record<string, any>;
      }[];
    },
  ) {
    return this.service.upsertBatch(user.sub, body.scores);
  }

  @Get()
  getAll(@User() user: any) {
    return this.service.getAll(user.sub);
  }

  @Get(':stockCode')
  getByStockCode(@User() user: any, @Param('stockCode') stockCode: string) {
    return this.service.getByStockCode(user.sub, stockCode);
  }
}
