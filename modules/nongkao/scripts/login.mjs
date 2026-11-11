#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { lstat } from 'node:fs/promises';
import { client, privateWrite, SESSION, ORIGIN } from './sync.mjs';

async function hiddenCode() {
  stdin.setRawMode(true); stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    function finish(error) { stdin.off('data', receive); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); error ? reject(error) : resolve(value); }
    function receive(chunk) {
      for (const c of chunk) {
        if (c === '\u0003') return finish(new Error('cancelled'));
        if (c === '\r' || c === '\n') return finish();
        if (c === '\u007f' || c === '\b') value = value.slice(0, -1);
        else if (/\d/.test(c) && value.length < 6) value += c;
      }
    }
    stdin.on('data', receive);
    stdout.write('รหัส OTP (ซ่อนขณะพิมพ์): ');
    stdin.resume();
  });
}
async function main() {
  if (!stdin.isTTY || !stdout.isTTY || process.platform === 'win32') throw new Error('Run in your own macOS/Linux/WSL Terminal; never put OTP in chat.');
  if (await lstat(SESSION).then(() => true, e => e.code === 'ENOENT' ? false : Promise.reject(e))) throw new Error('Existing login preserved. Move the old session.json to a private backup before reconnecting.');
  const rl = createInterface({ input: stdin, output: stdout });
  let email;
  try {
    console.log('ใช้เมลที่มีบัญชี Nongkao อยู่แล้ว หากใช้เมลใหม่ ระบบอาจสร้างบัญชีใหม่');
    email = (await rl.question('อีเมลบัญชี Nongkao ของคุณ: ')).trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('invalid_email');
    console.log(`จะส่ง OTP ไปยัง ${email} ผ่าน ${ORIGIN}`);
    if ((await rl.question('ยืนยันส่งรหัสและเชื่อมบัญชีนี้? พิมพ์ yes: ')).trim() !== 'yes') throw new Error('cancelled');
  } finally { rl.close(); }
  const api = client();
  await api('/auth/otp', { email });
  const code = await hiddenCode();
  if (!/^\d{6}$/.test(code)) throw new Error('invalid_code');
  const result = await api('/auth/verify', { email, code, label: 'knowledge-sync' });
  if (!/^[a-f0-9]{64}$/.test(result.token ?? '')) throw new Error('invalid_session_response');
  await privateWrite(SESSION, { origin: ORIGIN, token: result.token });
  console.log('เชื่อมบัญชีแล้ว เก็บ session ในไฟล์ส่วนตัวนอกโฟลเดอร์ skill; ไม่มีรหัสในแชตหรือแพ็กแจก');
}
main().catch(e => { console.error(e.code ? `local_${e.code}` : e.message); process.exitCode = 1; });
