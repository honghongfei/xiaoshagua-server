import { AppError } from '../../util/errors.js';
import { findCharacterById } from '../player/playerRepo.js';
import { getOnlineByPid } from '../player/playerService.js';
import * as repo from './socialRepo.js';

const blockCache = new Map<string, boolean>();

function key(viewer: number, target: number): string {
  return `${viewer}->${target}`;
}

export function isBlocked(viewer: number, target: number): boolean {
  if (viewer === target) return false;
  const k = key(viewer, target);
  const cached = blockCache.get(k);
  if (cached !== undefined) return cached;
  const v = repo.isRelation(viewer, target, 'block');
  blockCache.set(k, v);
  return v;
}

export function addFriend(self: number, other: number): void {
  if (self === other) throw new AppError('BAD_INPUT', 'cannot friend self');
  if (!findCharacterById(other)) throw new AppError('NOT_FOUND', 'target not found');
  repo.addRelation(self, other, 'friend');
}

export function removeFriend(self: number, other: number): void {
  repo.removeRelation(self, other, 'friend');
}

export function blockOther(self: number, other: number): void {
  if (self === other) throw new AppError('BAD_INPUT', 'cannot block self');
  if (!findCharacterById(other)) throw new AppError('NOT_FOUND', 'target not found');
  repo.addRelation(self, other, 'block');
  blockCache.set(key(self, other), true);
}

export function unblockOther(self: number, other: number): void {
  repo.removeRelation(self, other, 'block');
  blockCache.set(key(self, other), false);
}

export interface SocialEntry {
  pid: number;
  name: string;
  online: boolean;
  mapId: number | null;
}

function decorate(pid: number): SocialEntry {
  const ch = findCharacterById(pid);
  const on = getOnlineByPid(pid);
  return {
    pid,
    name: ch ? ch.name : `#${pid}`,
    online: !!on,
    mapId: on ? on.mapId : null,
  };
}

export function listFriends(self: number): SocialEntry[] {
  return repo.listOutgoing(self, 'friend').map(decorate);
}

export function listBlocks(self: number): SocialEntry[] {
  return repo.listOutgoing(self, 'block').map(decorate);
}

export function invalidateCacheFor(viewer: number): void {
  for (const k of Array.from(blockCache.keys())) {
    if (k.startsWith(`${viewer}->`)) blockCache.delete(k);
  }
}
