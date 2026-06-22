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
import { execFileSync } from 'node:child_process';

const srcDir = path.resolve(
  process.argv[2] || process.env.XSG_RELEASE_SRC || '../xiaoshagua-releases',
);
const destDir = path.resolve(process.env.RELEASES_DIR || './releases');

// 云分流相关开关（提前到顶部，下面拷贝/上传逻辑都要用）。
const cdnBase = (process.env.UPDATE_CDN_BASE || '').replace(/\/+$/, '');
const r2Remote = (process.env.XSG_R2_REMOTE || '').trim();
// XSG_SKIP_LOCAL_ZIP=1：服务器只留 manifest，不在 releases/ 落大 zip / 增量包（省磁盘）。
// 仅当 zip 确实会到 R2（配了 UPDATE_CDN_BASE 或 XSG_R2_REMOTE）才安全跳过；否则客户端回退
// /update/download 会 404 → 忽略跳过、仍保留本地副本并告警（fail-safe）。
const wantSkipLocalZip = /^(1|true|yes)$/i.test(process.env.XSG_SKIP_LOCAL_ZIP || '');
const zipOnRemote = Boolean(cdnBase) || Boolean(r2Remote);
const skipLocalZip = wantSkipLocalZip && zipOnRemote;
if (wantSkipLocalZip && !zipOnRemote) {
  console.warn(
    '[publish-release] WARN: XSG_SKIP_LOCAL_ZIP=1 但未配 UPDATE_CDN_BASE / XSG_R2_REMOTE，客户端将无处下载 zip；已忽略跳过、仍保留本地副本。',
  );
}

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

// 读 JSON 并容忍 UTF-8 BOM（PowerShell `Set-Content -Encoding UTF8` 会写 BOM, 否则 JSON.parse 报 Unexpected token '\uFEFF'）
function readJson(p) {
  let raw = fs.readFileSync(p, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw);
}

const srcManifest = path.join(srcDir, 'manifest.json');
if (!fs.existsSync(srcManifest)) {
  die('找不到 manifest.json: ' + srcManifest + '（先跑 tools/build_release.ps1）');
}

let manifest;
try {
  manifest = readJson(srcManifest);
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
if (skipLocalZip) {
  // 不在服务器落大 zip：清掉同名旧副本(若有)，避免服务器服旧包绕过 R2，仅留 manifest。
  try {
    if (fs.existsSync(destZip)) fs.rmSync(destZip);
  } catch (e) {
    console.warn(`[publish-release] WARN: 清理旧 zip 失败(${zipName}): ${e.message}`);
  }
  console.log(
    `[publish-release] 全量包跳过本地拷贝(XSG_SKIP_LOCAL_ZIP) -> 仅留 R2，客户端从 ${cdnBase || r2Remote} 下载 (${(zipStat.size / 1048576).toFixed(1)} MB)`,
  );
} else {
  fs.copyFileSync(srcZip, destZip);
  console.log(`[publish-release] 全量包 -> ${destZip} (${(zipStat.size / 1048576).toFixed(1)} MB)`);
}

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
    meta = readJson(path.join(srcDir, mfName));
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
  if (skipLocalZip) {
    // 同 full 包：跳过本地拷贝并清理同名旧增量包，仅把条目写进 manifest（客户端从 R2 取）。
    try {
      const oldPatch = path.join(destDir, meta.file);
      if (fs.existsSync(oldPatch)) fs.rmSync(oldPatch);
    } catch (e) {
      console.warn(`[publish-release] WARN: 清理旧增量包失败(${meta.file}): ${e.message}`);
    }
  } else {
    fs.copyFileSync(patchZipSrc, path.join(destDir, meta.file));
  }
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
  const prev = readJson(destManifest);
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

// ---- 可选: 把发布物上传到 R2/CDN(分流, 省服务器带宽) ----
// 设了 XSG_R2_REMOTE(rclone 远端, 如 "r2:xsg-updates") 就用 rclone 上传; 否则只列出待手动上传文件。
// 客户端从 <UPDATE_CDN_BASE>/<file> 直接下载; 服务端需把 UPDATE_CDN_BASE 配成同一个 base。
// 上传源固定用 srcDir(构建产物始终在此)，故 XSG_SKIP_LOCAL_ZIP 跳过本地拷贝时仍能上传。
const uploadFiles = [zipName, ...patches.map((p) => p.file)];
if (r2Remote) {
  for (const f of uploadFiles) {
    try {
      execFileSync('rclone', ['copyto', path.join(srcDir, f), `${r2Remote}/${f}`], { stdio: 'inherit' });
      console.log(`[publish-release] 已上传 R2: ${f}`);
    } catch (e) {
      console.warn(`[publish-release] WARN: rclone 上传失败(${f})，请手动上传: ${e.message}`);
    }
  }
} else {
  const tip = skipLocalZip
    ? '必须手动把以下文件传到 R2 桶根目录（已启用 XSG_SKIP_LOCAL_ZIP，服务器无本地副本，不传则客户端无处下载）：'
    : '需手动把以下文件传到 R2 桶根目录：';
  console.log('[publish-release] 未设 XSG_R2_REMOTE，跳过自动上传。' + tip);
  for (const f of uploadFiles) console.log('   - ' + f + '  (源: ' + path.join(srcDir, f) + ')');
}
if (cdnBase) {
  console.log(`[publish-release] 客户端将从 ${cdnBase}/${zipName} 直接下载（确保已上传 R2，且服务端 .env 已配 UPDATE_CDN_BASE=${cdnBase}）。`);
} else {
  console.log('[publish-release] 提示: 服务端 .env 配 UPDATE_CDN_BASE=<你的R2域名> 后, /update/manifest 自动把下载改写到 R2。');
}
if (skipLocalZip) {
  console.log('[publish-release] XSG_SKIP_LOCAL_ZIP: 服务器 releases/ 仅保留 manifest.json（未落大 zip / 增量包），磁盘占用最小化。');
}

console.log('[publish-release] 完成。客户端 GET /update/manifest 即可拿到新版本。');
