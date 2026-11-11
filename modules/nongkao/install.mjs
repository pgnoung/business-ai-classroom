#!/usr/bin/env node
import { mkdir, readdir, lstat, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

const source = dirname(fileURLToPath(import.meta.url));
const allowedFiles = ['SKILL.md', 'INSTALL_TH.md', 'install.mjs'];
const allowedDirs = ['agents', 'references', 'scripts', 'tests'];
async function collect(dir, rel = '') {
  const result = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    if (item.name === '.DS_Store') continue;
    if (!rel && !allowedFiles.includes(item.name) && !allowedDirs.includes(item.name)) continue;
    const path = join(dir, item.name), name = rel ? rel + '/' + item.name : item.name, stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('package_symlink_not_allowed');
    if (stat.isDirectory()) result.push(...await collect(path, name));
    else if (stat.isFile() && /\.(md|mjs|yaml)$/.test(name)) result.push([name, await readFile(path)]);
    else throw new Error('unexpected_package_file');
  }
  return result;
}
async function main() {
  const choice = process.argv[2];
  if (!['codex', 'claude', 'both'].includes(choice) || process.argv.length !== 3) {
    console.log('ใช้: node install.mjs codex | claude | both\nต้องมี Node.js 22+; ไม่ดาวน์โหลดและไม่เชื่อมบัญชีร้าน');
    process.exitCode = choice ? 1 : 0; return;
  }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22+ required');
  const files = await collect(source);
  if (!files.some(([name]) => name === 'SKILL.md')) throw new Error('incomplete_skill_package');
  const hosts = choice === 'both' ? ['codex', 'claude'] : [choice];
  for (const host of hosts) {
    const parent = join(homedir(), '.' + host, 'skills'), target = join(parent, 'nongkao-knowledge-sync');
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const existing = await lstat(target).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
    if (existing && await realpath(target).catch(() => '') === await realpath(source)) { console.log(`${host}: skill นี้ติดตั้งอยู่ที่ตำแหน่งปัจจุบันแล้ว`); continue; }
    const temp = join(homedir(), '.' + host, 'skill-install-staging', 'nongkao-' + randomUUID()); await mkdir(temp, { recursive: true, mode: 0o700 });
    for (const [name, data] of files) { const path = join(temp, name); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, data, { mode: 0o600, flag: 'wx' }); }
    let backup;
    if (existing) {
      backup = join(homedir(), '.' + host, 'skill-backups', 'nongkao-knowledge-sync-' + randomUUID());
      await mkdir(dirname(backup), { recursive: true, mode: 0o700 }); await rename(target, backup);
    }
    try { await rename(temp, target); }
    catch (error) { if (backup) await rename(backup, target); throw error; }
    console.log(`${host}: ติดตั้งแล้ว ${target}${backup ? '\nเก็บรุ่นเดิมไว้: ' + backup : ''}`);
  }
  console.log('เปิดแชตใหม่ แล้วพิมพ์: ใช้ nongkao-knowledge-sync ช่วยเชื่อมความรู้ร้านของฉัน ถามทีละข้อ');
}
if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) main().catch(e => { console.error(e.code ? `install_${e.code}` : e.message); process.exitCode = 1; });
