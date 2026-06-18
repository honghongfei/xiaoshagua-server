import { config } from '../../config.js';
import { AppError } from '../../util/errors.js';
import { hashPassword, verifyPassword } from '../../util/crypto.js';
import { newToken } from '../../util/ids.js';
import * as repo from './playerRepo.js';
import type { CharacterRow } from './playerRepo.js';

export interface AuthSession {
  token: string;
  accountId: number;
  characterId: number;
  expiresAt: number;
}

export interface CharacterPublic {
  pid: number;
  name: string;
  actorId: number;
  mapId: number;
  x: number;
  y: number;
  d: number;
  charSet: string | null;
  charIndex: number;
  level: number;
  gold: number;
}

export interface OnlinePlayer {
  pid: number;
  accountId: number;
  socketId: string;
  name: string;
  actorId: number;
  mapId: number;
  x: number;
  y: number;
  d: number;
  charSet: string | null;
  charIndex: number;
  level: number;
  lastActAt: number;
}

const onlineByPid = new Map<number, OnlinePlayer>();
const onlineBySocket = new Map<string, number>();

export function toPublic(row: CharacterRow): CharacterPublic {
  return {
    pid: row.id,
    name: row.name,
    actorId: row.actor_id,
    mapId: row.map_id,
    x: row.x,
    y: row.y,
    d: row.direction,
    charSet: row.char_set,
    charIndex: row.char_index,
    level: row.level,
    gold: row.gold,
  };
}

export interface RegisterInput {
  username: string;
  password: string;
  charName?: string;
  actorId?: number;
  charSet?: string;
  charIndex?: number;
}

export async function register(input: RegisterInput): Promise<AuthSession> {
  const existing = repo.findAccountByUsername(input.username);
  if (existing) throw new AppError('USERNAME_TAKEN', 'username already taken');
  const passwordHash = await hashPassword(input.password);
  const accountId = repo.createAccount({ username: input.username, passwordHash });
  const charName = input.charName ?? input.username;
  const characterId = repo.createCharacter({
    accountId,
    name: charName,
    actorId: input.actorId,
    charSet: input.charSet,
    charIndex: input.charIndex,
  });
  return issueToken(accountId, characterId);
}

export interface LoginInput {
  username: string;
  password: string;
}

export async function login(input: LoginInput): Promise<AuthSession> {
  const acc = repo.findAccountByUsername(input.username);
  if (!acc) throw new AppError('BAD_CREDENTIALS', 'wrong username or password');
  if (acc.banned) throw new AppError('BANNED', 'account banned');
  const ok = await verifyPassword(acc.password_hash, input.password);
  if (!ok) throw new AppError('BAD_CREDENTIALS', 'wrong username or password');
  let chr = repo.findFirstCharacterOfAccount(acc.id);
  if (!chr) {
    const characterId = repo.createCharacter({ accountId: acc.id, name: acc.username });
    chr = repo.findCharacterById(characterId);
    if (!chr) throw new AppError('INTERNAL', 'character creation failed', 500);
  }
  repo.touchLastLogin(acc.id);
  return issueToken(acc.id, chr.id);
}

export function resume(token: string): { session: AuthSession; character: CharacterPublic } {
  const row = repo.findAuthToken(token);
  if (!row) throw new AppError('TOKEN_INVALID', 'token not found');
  if (row.expires_at < Date.now()) {
    repo.deleteAuthToken(token);
    throw new AppError('TOKEN_EXPIRED', 'token expired');
  }
  const chr = repo.findCharacterById(row.character_id);
  if (!chr) throw new AppError('CHAR_GONE', 'character no longer exists');
  const session: AuthSession = {
    token: row.token,
    accountId: row.account_id,
    characterId: row.character_id,
    expiresAt: row.expires_at,
  };
  return { session, character: toPublic(chr) };
}

export function getCharacter(characterId: number): CharacterPublic {
  const chr = repo.findCharacterById(characterId);
  if (!chr) throw new AppError('CHAR_GONE', 'character not found');
  return toPublic(chr);
}

function issueToken(accountId: number, characterId: number): AuthSession {
  const token = newToken();
  const now = Date.now();
  const expiresAt = now + config.tokenTtlSec * 1000;
  repo.insertAuthToken({
    token,
    account_id: accountId,
    character_id: characterId,
    issued_at: now,
    expires_at: expiresAt,
  });
  return { token, accountId, characterId, expiresAt };
}

export function markOnline(p: OnlinePlayer): void {
  const prev = onlineByPid.get(p.pid);
  if (prev && prev.socketId !== p.socketId) {
    onlineBySocket.delete(prev.socketId);
  }
  onlineByPid.set(p.pid, p);
  onlineBySocket.set(p.socketId, p.pid);
}

export function markOffline(socketId: string): OnlinePlayer | undefined {
  const pid = onlineBySocket.get(socketId);
  if (pid === undefined) return undefined;
  const p = onlineByPid.get(pid);
  onlineBySocket.delete(socketId);
  if (p && p.socketId === socketId) {
    onlineByPid.delete(pid);
  }
  return p;
}

export function getOnlineByPid(pid: number): OnlinePlayer | undefined {
  return onlineByPid.get(pid);
}

export function getOnlineBySocket(socketId: string): OnlinePlayer | undefined {
  const pid = onlineBySocket.get(socketId);
  return pid === undefined ? undefined : onlineByPid.get(pid);
}

export function listOnline(): OnlinePlayer[] {
  return Array.from(onlineByPid.values());
}

export function persistPosition(p: OnlinePlayer): void {
  repo.updateCharacterPosition(p.pid, p.mapId, p.x, p.y, p.d);
}

export function updateCharacterAppearance(characterId: number, charSet: string, charIndex: number): void {
  repo.updateCharacterAppearance(characterId, charSet, charIndex);
}

// 改名: 写库 + 同步在线缓存里的 name(让后续 snapshot/world.delta 给别人看到新名字)
export function renameCharacter(characterId: number, name: string): { name: string } {
  const chr = repo.findCharacterById(characterId);
  if (!chr) throw new AppError('CHAR_GONE', 'character not found');
  repo.updateCharacterName(characterId, name);
  const online = onlineByPid.get(characterId);
  if (online) online.name = name;
  return { name };
}

// 清理过期 auth_token. 由 worldService 的后台定时器周期调用, 防止表只增不删.
export function pruneExpiredTokens(): number {
  return repo.pruneExpiredTokens();
}
