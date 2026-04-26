import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { AiMeetingResultEntity } from './entities/ai-meeting-result.entity';
import { UserEntity } from '../user/entities/user.entity';

@Injectable()
export class AiMeetingResultService {
  constructor(private readonly em: EntityManager) {}

  async upsertBatch(
    userId: number,
    items: {
      stockCode: string;
      stockName: string;
      score: number;
      reasoning: string;
      data: Record<string, any>;
    }[],
  ): Promise<AiMeetingResultEntity[]> {
    const user = await this.em.findOneOrFail(UserEntity, userId);
    const results: AiMeetingResultEntity[] = [];

    for (const item of items) {
      let entity = await this.em.findOne(AiMeetingResultEntity, {
        user: userId,
        stockCode: item.stockCode,
      });

      if (entity) {
        entity.stockName = item.stockName;
        entity.score = item.score;
        entity.reasoning = item.reasoning;
        entity.data = item.data;
      } else {
        entity = this.em.create(AiMeetingResultEntity, {
          user,
          stockCode: item.stockCode,
          stockName: item.stockName,
          score: item.score,
          reasoning: item.reasoning,
          data: item.data,
        });
        this.em.persist(entity);
      }
      results.push(entity);
    }

    await this.em.flush();
    return results;
  }

  async getAll(userId: number): Promise<AiMeetingResultEntity[]> {
    return this.em.find(
      AiMeetingResultEntity,
      { user: userId },
      { orderBy: { updatedAt: 'DESC' } },
    );
  }

  async getByStockCode(
    userId: number,
    stockCode: string,
  ): Promise<AiMeetingResultEntity | null> {
    return this.em.findOne(AiMeetingResultEntity, {
      user: userId,
      stockCode,
    });
  }
}
