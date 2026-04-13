import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { AiMeetingResultController } from './ai-meeting-result.controller';
import { AiMeetingResultService } from './ai-meeting-result.service';
import { AiMeetingResultEntity } from './entities/ai-meeting-result.entity';

@Module({
  imports: [MikroOrmModule.forFeature([AiMeetingResultEntity])],
  controllers: [AiMeetingResultController],
  providers: [AiMeetingResultService],
  exports: [AiMeetingResultService],
})
export class AiMeetingResultModule {}
