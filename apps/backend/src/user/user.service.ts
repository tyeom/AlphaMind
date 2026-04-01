import {
  Injectable,
  ConflictException,
  NotFoundException,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import * as bcrypt from 'bcrypt';
import { UserEntity } from './entities/user.entity';
import { SignUpDto } from './dto/sign-up.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { UserRole } from '@alpha-mind/common';

@Injectable()
export class UserService implements OnModuleInit {
  private readonly logger = new Logger(UserService.name);

  constructor(private readonly em: EntityManager) {}

  async onModuleInit() {
    await this.seedDefaultAdmin();
  }

  private async seedDefaultAdmin() {
    const existingAdmin = await this.em.findOne(UserEntity, {
      role: UserRole.ADMIN,
    });

    if (!existingAdmin) {
      const hashedPassword = await bcrypt.hash('1234', 10);
      const admin = this.em.create(UserEntity, {
        username: 'admin',
        password: hashedPassword,
        email: 'admin@alpha-mind.com',
        name: 'Administrator',
        role: UserRole.ADMIN,
      });
      await this.em.persistAndFlush(admin);
      this.logger.log('기본 관리자 계정이 생성되었습니다. [admin / 1234]');
    }
  }

  async signUp(dto: SignUpDto): Promise<Omit<UserEntity, 'password'>> {
    const existing = await this.em.findOne(UserEntity, {
      $or: [{ username: dto.username }, { email: dto.email }],
    });

    if (existing) {
      throw new ConflictException('이미 존재하는 아이디 또는 이메일입니다.');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const user = this.em.create(UserEntity, {
      ...dto,
      password: hashedPassword,
    });
    await this.em.persistAndFlush(user);

    const { password, ...result } = user;
    return result as Omit<UserEntity, 'password'>;
  }

  async validateUser(
    username: string,
    pass: string,
  ): Promise<UserEntity | null> {
    const user = await this.em.findOne(UserEntity, { username });
    if (!user) return null;

    const isMatch = await bcrypt.compare(pass, user.password);
    if (!isMatch) return null;

    return user;
  }

  async findById(id: number): Promise<UserEntity> {
    const user = await this.em.findOne(UserEntity, { id });
    if (!user) {
      throw new NotFoundException('사용자를 찾을 수 없습니다.');
    }
    return user;
  }

  async findAll(): Promise<Omit<UserEntity, 'password'>[]> {
    const users = await this.em.findAll(UserEntity);
    return users.map((user) => {
      const { password, ...result } = user;
      return result as Omit<UserEntity, 'password'>;
    });
  }

  async updateUser(
    id: number,
    dto: UpdateUserDto,
  ): Promise<Omit<UserEntity, 'password'>> {
    const user = await this.findById(id);

    if (dto.email) user.email = dto.email;
    if (dto.name) user.name = dto.name;
    if (dto.password) {
      user.password = await bcrypt.hash(dto.password, 10);
    }

    await this.em.persistAndFlush(user);

    const { password, ...result } = user;
    return result as Omit<UserEntity, 'password'>;
  }

  async adminUpdateUser(
    id: number,
    dto: AdminUpdateUserDto,
  ): Promise<Omit<UserEntity, 'password'>> {
    const user = await this.findById(id);

    if (dto.email) user.email = dto.email;
    if (dto.name) user.name = dto.name;
    if (dto.role) user.role = dto.role;
    if (dto.password) {
      user.password = await bcrypt.hash(dto.password, 10);
    }

    await this.em.persistAndFlush(user);

    const { password, ...result } = user;
    return result as Omit<UserEntity, 'password'>;
  }
}
