import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  ParseIntPipe,
} from '@nestjs/common';
import { NotificationService } from './notification.service';
import { NotificationType } from './entities/notification.entity';
import { User } from '../decorator/user.decorator';

const TYPE_MAP: Record<string, NotificationType> = {
  ai_meeting_started: NotificationType.AI_MEETING_STARTED,
  ai_meeting_completed: NotificationType.AI_MEETING_COMPLETED,
  ai_meeting_error: NotificationType.AI_MEETING_ERROR,
  scheduled_scan_warning: NotificationType.SCHEDULED_SCAN_WARNING,
  buy_signal: NotificationType.BUY_SIGNAL,
  sell_signal: NotificationType.SELL_SIGNAL,
};

@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Post('create')
  async create(
    @User() user: any,
    @Body()
    body: {
      type: string;
      title: string;
      message: string;
      metadata?: Record<string, any>;
    },
  ) {
    const notifType = TYPE_MAP[body.type];
    if (!notifType) return { error: 'Invalid notification type' };
    return this.notificationService.create(
      user.sub,
      notifType,
      body.title,
      body.message,
      body.metadata,
    );
  }

  @Get()
  getAll(@User() user: any) {
    return this.notificationService.getAll(user.sub);
  }

  @Get('unread-count')
  getUnreadCount(@User() user: any) {
    return this.notificationService.getUnreadCount(user.sub);
  }

  @Patch(':id/read')
  markAsRead(@User() user: any, @Param('id', ParseIntPipe) id: number) {
    return this.notificationService.markAsRead(id, user.sub);
  }

  @Patch('read-all')
  markAllAsRead(@User() user: any) {
    return this.notificationService.markAllAsRead(user.sub);
  }

  @Delete(':id')
  delete(@User() user: any, @Param('id', ParseIntPipe) id: number) {
    return this.notificationService.delete(id, user.sub);
  }
}
