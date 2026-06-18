import { z } from 'zod';

const Username = z
  .string()
  .min(3)
  .max(16)
  .regex(/^[A-Za-z0-9_\u4e00-\u9fa5]+$/, 'username contains illegal chars');

const Password = z.string().min(6).max(64);

const CharName = z
  .string()
  .min(1)
  .max(12)
  .regex(/^[A-Za-z0-9_\u4e00-\u9fa5]+$/, 'name contains illegal chars');

export const AuthLogin = z.object({
  username: Username,
  password: Password,
  clientVer: z.string().max(32).optional(),
});

export const AuthRegister = z.object({
  username: Username,
  password: Password,
  charName: CharName.optional(),
  actorId: z.number().int().min(1).max(999).optional(),
  charSet: z.string().max(64).optional(),
  charIndex: z.number().int().min(0).max(7).optional(),
  clientVer: z.string().max(32).optional(),
});

export const AuthResume = z.object({
  token: z.string().min(8).max(64),
  lastSeq: z.number().int().nonnegative().optional(),
});

export const CharRename = z.object({
  name: CharName,
});

export const PlayerEnterMap = z.object({
  mapId: z.number().int().min(1),
  x: z.number().int().min(0).max(999),
  y: z.number().int().min(0).max(999),
  d: z.number().int().refine((v) => v === 2 || v === 4 || v === 6 || v === 8, {
    message: 'd must be 2/4/6/8',
  }),
  charSet: z.string().max(64).optional(),
  charIndex: z.number().int().min(0).max(7).optional(),
});

export const PlayerMove = z.object({
  x: z.number().int().min(0).max(999),
  y: z.number().int().min(0).max(999),
  d: z.number().int().refine((v) => v === 2 || v === 4 || v === 6 || v === 8, {
    message: 'd must be 2/4/6/8',
  }),
  ts: z.number().int().nonnegative().optional(),
});

export const PlayerAction = z.object({
  type: z.string().min(1).max(24),
});

export const ChatSend = z.object({
  channel: z.enum(['world', 'nearby', 'whisper']),
  text: z.string().min(1).max(200),
  targetPid: z.number().int().positive().optional(),
});

export const PidOnly = z.object({
  pid: z.number().int().positive(),
});

export const PidWithKind = z.object({
  pid: z.number().int().positive(),
  kind: z.enum(['friend', 'block']),
});

// 按名字搜人(用于远距离加好友, 不必同图/在线)
export const SocialSearch = z.object({
  name: z.string().min(1).max(16),
});

export const InventoryGainGold = z.object({
  amount: z.number().int(),
  reason: z.string().max(32).optional(),
});

export const ItemKind = z.enum(['item', 'weapon', 'armor']);

export const InventoryGainItem = z.object({
  kind: ItemKind,
  dataId: z.number().int().positive(),
  amount: z.number().int(),
  reason: z.string().max(32).optional(),
});

export const InventoryUse = z.object({
  kind: ItemKind,
  dataId: z.number().int().positive(),
  count: z.number().int().positive().default(1),
});

// inventory.replace: 全量覆盖资产 (SaveMigrate 上传本地存档时调用)
// 上限: 单次不超过 5000 条 entry, 防止滥用.
export const InventoryReplace = z.object({
  gold: z.number().int().min(0),
  items: z
    .array(
      z.object({
        kind: ItemKind,
        dataId: z.number().int().positive(),
        count: z.number().int().min(0),
      }),
    )
    .max(5000),
  reason: z.string().max(32).optional(),
});

export const StateSetSwitch = z.object({
  id: z.number().int().min(1),
  value: z.union([z.literal(0), z.literal(1)]),
});

export const StateSetVar = z.object({
  id: z.number().int().min(1),
  value: z.number().int(),
});

export const SaveUpload = z.object({
  contents: z.string().max(2_000_000),
  meta: z.record(z.string(), z.unknown()).optional(),
  // 乐观并发: 客户端上传时带上"它最后一次见到的云档 ts". 服务端若发现当前云档
  // 比这个 baseTs 还新, 说明客户端在覆盖一份它没看过的更新存档 -> 拒绝(SAVE_STALE).
  // 不传(老客户端/兜底路径)则按旧行为无条件写入, 向后兼容.
  baseTs: z.number().int().nonnegative().optional(),
});

export const TradeInvite = z.object({ targetPid: z.number().int().positive() });
export const TradeRespond = z.object({ tradeId: z.string().min(1), accept: z.boolean() });
export const TradeOffer = z.object({
  tradeId: z.string().min(1),
  gold: z.number().int().min(0),
  items: z
    .array(
      z.object({
        kind: ItemKind,
        dataId: z.number().int().positive(),
        count: z.number().int().positive(),
      }),
    )
    .max(20),
});
export const TradeIdOnly = z.object({ tradeId: z.string().min(1) });

export const PetCreate = z.object({
  speciesId: z.number().int().min(1),
  name: z.string().min(1).max(12),
});

export const PetAct = z.object({
  petId: z.number().int().positive(),
  // M6 修：移除 'plant'，未实现。如果以后要加，去 petService.act 实现后再补回。
  action: z.enum(['feed', 'train', 'evolve']),
});

export const DungeonEnter = z.object({
  dungeonId: z.string().min(1).max(32),
  partyIds: z.array(z.number().int().positive()).max(8).optional(),
});

export type AuthLoginInput = z.infer<typeof AuthLogin>;
export type AuthRegisterInput = z.infer<typeof AuthRegister>;
export type AuthResumeInput = z.infer<typeof AuthResume>;
export type CharRenameInput = z.infer<typeof CharRename>;
export type PlayerEnterMapInput = z.infer<typeof PlayerEnterMap>;
export type PlayerMoveInput = z.infer<typeof PlayerMove>;
export type PlayerActionInput = z.infer<typeof PlayerAction>;
export type ChatSendInput = z.infer<typeof ChatSend>;
export type SocialSearchInput = z.infer<typeof SocialSearch>;
export type InventoryGainGoldInput = z.infer<typeof InventoryGainGold>;
export type InventoryGainItemInput = z.infer<typeof InventoryGainItem>;
export type InventoryUseInput = z.infer<typeof InventoryUse>;
export type InventoryReplaceInput = z.infer<typeof InventoryReplace>;
export type StateSetSwitchInput = z.infer<typeof StateSetSwitch>;
export type StateSetVarInput = z.infer<typeof StateSetVar>;
export type SaveUploadInput = z.infer<typeof SaveUpload>;
export type TradeOfferInput = z.infer<typeof TradeOffer>;
export type PetActInput = z.infer<typeof PetAct>;
export type DungeonEnterInput = z.infer<typeof DungeonEnter>;
