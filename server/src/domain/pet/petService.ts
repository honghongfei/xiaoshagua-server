import { AppError } from '../../util/errors.js';
import { config } from '../../config.js';
import * as invRepo from '../inventory/inventoryRepo.js';
import * as repo from './petRepo.js';
import type { PetRow } from './petRepo.js';

const COOL_MS = 4 * 60 * 60 * 1000; // 4h default cooldown for feed/train
const EXP_PER_FEED = 20;
const EXP_PER_TRAIN = 50;
const LEVEL_UP_EXP = (lv: number) => 100 + lv * 30;
const EVOLVE_LV = [10, 25, 40];

export interface PetPublic {
  id: number;
  characterId: number;
  speciesId: number;
  speciesName?: string | null;
  name: string;
  stage: number;
  level: number;
  exp: number;
  coolUntil: number;
}

export function toPublic(r: PetRow): PetPublic {
  return {
    id: r.id,
    characterId: r.character_id,
    speciesId: r.species_id,
    speciesName: r.species_name,
    name: r.name ?? '',
    stage: r.stage,
    level: r.level,
    exp: r.exp,
    coolUntil: r.cool_until,
  };
}

export function list(characterId: number): PetPublic[] {
  return repo.listPets(characterId).map(toPublic);
}

export function adopt(characterId: number, speciesId: number, name: string, speciesName?: string): PetPublic {
  const id = repo.createPet(characterId, speciesId, name, speciesName);
  const row = repo.findPet(id);
  if (!row) throw new AppError('INTERNAL', 'create pet failed', 500);
  return toPublic(row);
}

function applyExp(p: PetRow, gain: number): { leveledUp: boolean; newLv: number } {
  p.exp += gain;
  let leveled = false;
  let lv = p.level;
  while (p.exp >= LEVEL_UP_EXP(lv)) {
    p.exp -= LEVEL_UP_EXP(lv);
    lv += 1;
    leveled = true;
    if (lv > 99) { lv = 99; p.exp = 0; break; }
  }
  p.level = lv;
  return { leveledUp: leveled, newLv: lv };
}

function ensureOwned(petId: number, characterId: number): PetRow {
  const r = repo.findPet(petId);
  if (!r) throw new AppError('NOT_FOUND', 'pet not found');
  if (r.character_id !== characterId) throw new AppError('FORBIDDEN', 'not your pet');
  return r;
}

function ensureNotCool(r: PetRow): void {
  if (r.cool_until > Date.now()) {
    throw new AppError('COOLING', `cool until ${r.cool_until}`);
  }
}

export interface ActResult {
  pet: PetPublic;
  delta: { exp?: number; leveledUp?: boolean; evolved?: boolean; regressed?: boolean; stage?: number };
}

export function feed(petId: number, characterId: number): ActResult {
  const r = ensureOwned(petId, characterId);
  ensureNotCool(r);
  const { leveledUp } = applyExp(r, EXP_PER_FEED);
  r.cool_until = Date.now() + COOL_MS;
  repo.updatePet(r.id, {
    exp: r.exp,
    level: r.level,
    cool_until: r.cool_until,
  });
  repo.logAction(r.id, characterId, 'feed', leveledUp ? 'leveled' : 'ok');
  return { pet: toPublic(r), delta: { exp: EXP_PER_FEED, leveledUp } };
}

export function train(petId: number, characterId: number): ActResult {
  const r = ensureOwned(petId, characterId);
  ensureNotCool(r);
  const { leveledUp } = applyExp(r, EXP_PER_TRAIN);
  r.cool_until = Date.now() + COOL_MS;
  repo.updatePet(r.id, {
    exp: r.exp,
    level: r.level,
    cool_until: r.cool_until,
  });
  repo.logAction(r.id, characterId, 'train', leveledUp ? 'leveled' : 'ok');
  return { pet: toPublic(r), delta: { exp: EXP_PER_TRAIN, leveledUp } };
}

export function evolve(petId: number, characterId: number): ActResult {
  const r = ensureOwned(petId, characterId);
  const targetStage = r.stage + 1;
  if (targetStage > 3) throw new AppError('MAX_STAGE', 'pet already final form');
  const reqLv = EVOLVE_LV[r.stage] ?? Infinity;
  if (r.level < reqLv) throw new AppError('LOW_LEVEL', `need level ${reqLv}`);
  r.stage = targetStage;
  repo.updatePet(r.id, { stage: r.stage });
  repo.logAction(r.id, characterId, 'evolve', `stage=${targetStage}`);
  return { pet: toPublic(r), delta: { evolved: true, stage: targetStage } };
}

// 退化回蛋「换形态」：付费把 stage 归 0（回蛋），保留 level / exp，让玩家重新进化换形态。
// 收费金币销毁（gold sink）。冷却不重置，避免刷动作。
export function regress(petId: number, characterId: number): ActResult {
  const r = ensureOwned(petId, characterId);
  if (r.stage <= 0) throw new AppError('BAD_STATE', 'pet already at egg stage');
  const fee = config.petRegressFeeGold;
  return invRepo.tx((db) => {
    if (fee > 0) {
      const gold = invRepo.getGold(characterId);
      if (gold < fee) throw new AppError('NOT_ENOUGH_GOLD', `need ${fee}, have ${gold}`);
      invRepo.applyGoldDelta(db, characterId, -fee); // 销毁
    }
    r.stage = 0;
    repo.updatePet(r.id, { stage: 0 });
    repo.logAction(r.id, characterId, 'regress', `to-egg fee=${fee} keepLv=${r.level}`);
    return { pet: toPublic(r), delta: { stage: 0, regressed: true } };
  });
}
