import { api } from './client';
import type {
  User,
  SignUpRequest,
  UpdateUserRequest,
  AdminUpdateUserRequest,
} from '../types/user';

export async function signUp(dto: SignUpRequest): Promise<User> {
  return api.post<User>('/users/sign-up', dto);
}

export async function getMe(): Promise<User> {
  return api.get<User>('/users/me');
}

export async function updateMe(dto: UpdateUserRequest): Promise<User> {
  return api.patch<User>('/users/me', dto);
}

export async function getAllUsers(): Promise<User[]> {
  return api.get<User[]>('/users');
}

export async function adminUpdateUser(
  id: number,
  dto: AdminUpdateUserRequest,
): Promise<User> {
  return api.patch<User>(`/users/${id}`, dto);
}
