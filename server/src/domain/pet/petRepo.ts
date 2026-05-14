import { openDb } from '../../db/sqlite.js';

export interface PetRow {
  id: number;
  character_id: number;
  species_id: number;
  species_name: string | null;
  name: string | null;
  stage: number;
  level: number;
  exp: number;
  cool_until: number;
  extra_json: string | null;
  created_at: number;
  updated_at: number;
}

export function listPets(characterId: number): PetRow[] {
  const db = openDb();
  return db
    .prepare<[number], PetRow>('SELECT * FROM pet WHERE character_id = ? ORDER BY id ASC')
    .all(characterId);
}

export function findPet(petId: number): PetRow | undefined {
  const db = openDb();
  return db.prepare<[number], PetRow>('SELECT * FROM pet WHERE id = ?').get(petId);
}

export function createPet(
  characterId: number,
  speciesId: number,
  name: string,
  speciesName?: string,
): number {
  const db = openDb();
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO pet (character_id, species_id, species_name, name, stage, level, exp, cool_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 1, 0, 0, ?, ?)`,
    )
    .run(characterId, speciesId, speciesName ?? null, name, now, now);
  return Number(info.lastInsertRowid);
}

export function updatePet(petId: number, patch: Partial<PetRow>): void {
  const db = openDb();
  const cur = findPet(petId);
  if (!cur) return;
  const next = { ...cur, ...patch, updated_at: Date.now() };
  db.prepare(
    `UPDATE pet SET species_id=?, species_name=?, name=?, stage=?, level=?, exp=?, cool_until=?, extra_json=?, updated_at=? WHERE id=?`,
  ).run(
    next.species_id,
    next.species_name,
    next.name,
    next.stage,
    next.level,
    next.exp,
    next.cool_until,
    next.extra_json,
    next.updated_at,
    petId,
  );
}

export function logAction(petId: number, characterId: number, action: string, result: string): void {
  const db = openDb();
  db.prepare(
    'INSERT INTO pet_action_log (ts, pet_id, character_id, action, result) VALUES (?, ?, ?, ?, ?)',
  ).run(Date.now(), petId, characterId, action, result);
}
