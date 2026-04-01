import {
  Controller,
  Post,
  Body,
  Get,
  Patch,
  Param,
  ParseIntPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { UserService } from './user.service';
import { SignUpDto } from './dto/sign-up.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { Public, Roles, UserRole } from '@alpha-mind/common';
import { User } from '../decorator/user.decorator';

@ApiTags('Users')
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Public()
  @Post('sign-up')
  @ApiOperation({ summary: '회원가입' })
  async signUp(@Body() dto: SignUpDto) {
    return this.userService.signUp(dto);
  }

  @Get('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: '내 정보 조회' })
  async getMe(@User() user: any) {
    return this.userService.findById(user.sub);
  }

  @Patch('me')
  @ApiBearerAuth()
  @ApiOperation({ summary: '내 정보 수정' })
  async updateMe(@User() user: any, @Body() dto: UpdateUserDto) {
    return this.userService.updateUser(user.sub, dto);
  }

  @Roles(UserRole.ADMIN)
  @Get()
  @ApiBearerAuth()
  @ApiOperation({ summary: '전체 사용자 목록 조회 (관리자)' })
  async findAll() {
    return this.userService.findAll();
  }

  @Roles(UserRole.ADMIN)
  @Patch(':id')
  @ApiBearerAuth()
  @ApiOperation({ summary: '사용자 정보 수정 (관리자)' })
  @ApiParam({ name: 'id', description: '사용자 ID' })
  async adminUpdateUser(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AdminUpdateUserDto,
  ) {
    return this.userService.adminUpdateUser(id, dto);
  }
}
