import { Controller, Post, Body, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { SignInDto } from '../user/dto/sign-in.dto';
import { Public } from '@alpha-mind/common';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('sign-in')
  @ApiOperation({ summary: '로그인' })
  async signIn(@Body() dto: SignInDto) {
    return this.authService.signIn(dto);
  }

  @Post('sign-out')
  @ApiBearerAuth()
  @ApiOperation({ summary: '로그아웃' })
  async signOut(@Req() req: Request) {
    const token = req.headers.authorization?.split(' ')[1];
    return this.authService.signOut(token!);
  }
}
