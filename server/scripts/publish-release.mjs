#!/usr/bin/env node
// =============================================================
// publish-release.mjs
// 把 build_release.ps1 产出的 (zip + manifest.json) 发布到 server/releases/。
//
// 用法:
//   node scripts/publish-release.mjs [srcDir]
//   npm run publish:release -- "D:\agentsxiaoshagua\xiaoshagua-releases"
//
// srcDir 缺省取环境变量 XSG_RELEASE_SRC, 再缺省取 ../xiaoshagua-releases。
// 目标目录取环境变量 RELEASES_DIR, 缺省 ./releases。
// =============================================================
import fs from 'node:fs';
import path from 'node:path';

const srcDir = path.resolve(
  process.argv[2] || process.env.XSG_RELEASE_SRC || '../xiaoshagua-releases',
);
const destDir = path.resolve(process.env.RELEASES_DIR || './releases');

function die(msg) {
  console.error('[publish-release] ERROR: ' + msg);
  process.exit(1);
}

function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

const srcManifest = path.join(srcDir, 'manifest.json');
if (!fs.existsSync(srcManifest)) {
  die('找不到 manifest.json: ' + srcManifest + '（先跑 tools/build_release.ps1）');
}

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(srcManifest, 'utf8'));
} catch (e) {
  die('manifest.json 解析失败: ' + e.message);
}

const zipName = manifest && manifest.full && manifest.full.file;
if (!zipName) {
  die('manifest.full.file 为空，无法确定包文件名');
}
const srcZip = path.join(srcDir, zipName);
if (!fs.existsSync(srcZip)) {
  die('找不到包文件: ' + srcZip);
}

// 校验 zip 大小与 manifest 一致（基本完整性）
const zipStat = fs.statSync(srcZip);
if (manifest.full.size && zipStat.size !== manifest.full.size) {
  console.warn(
    `[publish-release] WARN: zip 大小(${zipStat.size}) 与 manifest.size(${manifest.full.size}) 不一致`,
  );
}

fs.mkdirSync(destDir, { recursive: true });

const destZip = path.join(destDir, zipName);
fs.copyFileSync(srcZip, destZip);
console.log(`[publish-release] 全量包 -> ${destZip} (${(zipStat.size / 1048576).toFixed(1)} MB)`);

// ---- 合并增量 patch ----
// make_patch.ps1 产出 patch-<from>-to-<to>.zip + patch-<from>-to-<to>.meta.json,
// 但只有在这里把它们合并进对外 manifest.patches[], 客户端 doUpdate 才会真正走增量。
// 客户端只认 from===本地 && to===latest, 故仅纳入 to===latest 且 zip 存在的条目。
const patches = [];
let metaFiles = [];
try {
  metaFiles = fs.readdirSync(srcDir).filter((f) => /^patch-.+\.meta\.json$/.test(f));
} catch {
  metaFiles = [];
}
const seenFrom = new Set();
for (const mfName of metaFiles) {
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(path.join(srcDir, mfName), 'utf8'));
  } catch (e) {
    console.warn(`[publish-release] WARN: 跳过无法解析的 patch meta: ${mfName} (${e.message})`);
    continue;
  }
  if (!meta || !meta.from || !meta.to || !meta.file) {
    console.warn(`[publish-release] WARN: 跳过字段缺失的 patch meta: ${mfName}`);
    continue;
  }
  if (String(meta.to) !== String(manifest.latest)) {
    console.log(
      `[publish-release] 略过非当前版本 patch: ${meta.from} -> ${meta.to} (latest=${manifest.latest})`,
    );
    continue;
  }
  if (seenFrom.has(String(meta.from))) {
    console.warn(`[publish-release] WARN: 重复 from=${meta.from}, 保留先出现者, 跳过 ${mfName}`);
    continue;
  }
  const patchZipSrc = path.join(srcDir, meta.file);
  if (!fs.existsSync(patchZipSrc)) {
    console.warn(`[publish-release] WARN: patch 包缺失, 跳过: ${meta.file}`);
    continue;
  }
  const pStat = fs.statSync(patchZipSrc);
  if (meta.size && pStat.size !== meta.size) {
    console.warn(
      `[publish-release] WARN: patch 包大小(${pStat.size}) 与 meta(${meta.size}) 不一致: ${meta.file}`,
    );
  }
  fs.copyFileSync(patchZipSrc, path.join(destDir, meta.file));
  patches.push({
    from: String(meta.from),
    to: String(meta.to),
    file: meta.file,
    sha256: meta.sha256 || '',
    size: pStat.size,
    deletes: Array.isArray(meta.deletes) ? meta.deletes : [],
  });
  seenFrom.add(String(meta.from));
  console.log(
    `[publish-release] 增量包 -> ${meta.file} (${meta.from} -> ${meta.to}, ${(pStat.size / 1048576).toFixed(1)} MB)`,
  );
}

// ---- 保留强制更新门槛 minVersion ----
// 构建产物 manifest 里 minVersion 恒为 0.0.0; 若直接写出会把"真·强制更新"门槛清空。
// 规则: XSG_MIN_VERSION 环境变量优先; 否则取(现网 manifest, 构建产物)中较高者。
const destManifest = path.join(destDir, 'manifest.json');
let minVersion = String(manifest.minVersion || '0.0.0');
try {
  const prev = JSON.parse(fs.readFileSync(destManifest, 'utf8'));
  if (prev && typeof prev.minVersion === 'string' && cmpVer(prev.minVersion, minVersion) > 0) {
    minVersion = prev.minVersion;
  }
} catch {
  // 现网无 manifest -> 用构建值
}
const envMin = (process.env.XSG_MIN_VERSION || '').trim();
if (/^\d+\.\d+\.\d+$/.test(envMin)) minVersion = envMin;

// ---- 写出合并后的对外 manifest (full + patches + 保留的 minVersion) ----
const outManifest = { ...manifest, minVersion, patches };
fs.writeFileSync(destManifest, JSON.stringify(outManifest, null, 2), 'utf8');
console.log(
  `[publish-release] 清单 -> ${destManifest} (latest=${manifest.latest}, minVersion=${minVersion}, patches=${patches.length})`,
);

console.log('[publish-release] 完成。客户端 GET /update/manifest 即可拿到新版本。');
