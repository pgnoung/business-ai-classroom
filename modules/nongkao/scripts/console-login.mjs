#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { lstat } from 'node:fs/promises';
import { privateWrite } from './sync.mjs';
import { consoleOrigin, consoleSessionPath } from './console.mjs';

async function password() {
  stdin.setRawMode(true); stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = error => { stdin.off('data', receive); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); error ? reject(error) : resolve(value); };
    function receive(chunk) {
      for (const c of chunk) {
        if (c === '\u0003') return finish(new Error('cancelled'));
        if (c === '\r' || c === '\n') return finish();
        if (c === '\u007f' || c === '\b') value = [...value].slice(0, -1).join('');
        else if (!/[\u0000-\u001f]/.test(c)) value += c;
      }
    }
    stdin.on('data', receive); stdout.write('รหัสผ่าน Console (ซ่อนขณะพิมพ์): '); stdin.resume();
  });
}
async function main() {
  if (!stdin.isTTY || !stdout.isTTY || process.platform === 'win32') throw new Error('Use your own macOS/Linux/WSL Terminal');
  const rl = createInterface({ input: stdin, output: stdout });
  let origin, username;
  try {
    origin = consoleOrigin((await rl.question('URL Console ของร้านคุณ (https://.../console): ')).trim());
    if (await lstat(consoleSessionPath(origin)).then(() => true, e => e.code === 'ENOENT' ? false : Promise.reject(e))) throw new Error('existing_console_session_preserved');
    username = (await rl.question('ชื่อผู้ใช้ Console: ')).trim();
    if (!username) throw new Error('username_required');
    console.log(`เชื่อม ${origin} ด้วยบัญชี ${username} เพื่ออ่านคลังความรู้และตรวจผลนำเข้า`);
    if ((await rl.question('ตรวจว่าเป็นโดเมนของร้านคุณแล้ว พิมพ์ yes: ')).trim() !== 'yes') throw new Error('cancelled');
  } finally { rl.close(); }
  const secret = await password();
  if (!secret) throw new Error('password_required');
  let r;
  try { r = await fetch(origin + '/console/api/login', { method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ username, password: secret }), redirect: 'error', signal: AbortSignal.timeout(20000) }); }
  catch { throw new Error('console_login_network_failed_no_retry'); }
  const data = await r.json().catch(() => { throw new Error('console_login_invalid_response'); });
  if (!r.ok || data.ok !== true || data.operator?.username !== username) throw new Error('console_login_failed');
  const raw = r.headers.getSetCookie().find(c => c.startsWith('chassis_session='));
  const cookie = raw?.split(';')[0];
  if (!/^chassis_session=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cookie ?? '')) throw new Error('console_session_invalid');
  await privateWrite(consoleSessionPath(origin), { origin, username, cookie });
  console.log('เชื่อม Console แล้ว เก็บเฉพาะ session ในไฟล์ส่วนตัว ไม่เก็บรหัสผ่าน');
}
main().catch(e => { console.error(e instanceof SyntaxError ? 'invalid_json' : e.code ? `local_${e.code}` : e.message); process.exitCode = 1; });
