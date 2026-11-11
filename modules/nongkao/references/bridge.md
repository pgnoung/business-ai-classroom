# Nongkao ↔ ลูกแพรสำหรับนักเรียน

## สิ่งที่รองรับจริง

| ทิศทาง | ช่องทาง |
|---|---|
| ลูกแพร / AI Admin Console → Nongkao | อ่าน `/console/api/knowledge` และ `/prices` ของบัญชีผู้เรียน แล้วแปลงรายการที่เลือกเข้า Nongkao API เดิม |
| Nongkao → AI Admin Starter | อ่าน active version → รวมลงสำเนา `business/` → dry-run และ import ผ่าน `ai-admin.sh` ของผู้เรียน → อ่าน Console ยืนยัน → อัปเดต `business/` ตัวจริง |

ขาเข้าลูกแพรรองรับ **AI Admin Starter ที่มี `ai-admin.sh`, `business/` และ
`tools/starter-import.mjs`** หากเป็นลูกแพรรุ่นเก่า/custom ที่ไม่มีตัวนำเข้านี้ ให้เตรียม bundle
และแจ้งว่ายังนำเข้าตรงไม่ได้ ห้ามยิง SQL หรือใช้คีย์เจ้าของระบบอื่นเป็นทางลัด
ทดสอบตาม API ของแพ็กนี้ การติดตั้งคนละรุ่นต้องตรวจว่า schema ตรงก่อนเขียนจริง
Source business knowledge ไม่ใช่ทุกชั้นของสมอง เช่น rules/ราคา/memory/persona ใช้แทนกันไม่ได้

## Onboarding ที่ผู้เรียนเห็น

ถามทีละข้อและข้ามสิ่งที่รู้แล้ว:

1. ต้นทาง → ปลายทางอะไร (หรือทราบจากคำสั่งแล้ว)
2. ชื่อร้านและช่องทางที่ต้องการ; ทั้งสองร้านเป็นของผู้เรียนและอนุญาตให้ย้ายข้อมูลระหว่างกันหรือไม่
3. ฝั่งลูกแพรมีชุด AI Admin Starter อยู่โฟลเดอร์ไหน และ URL Console อะไร
4. เชื่อม Nongkao ตาม SKILL.md และเชื่อม Console ด้วย `node <skill>/scripts/console-login.mjs`
   ผู้เรียนกรอกชื่อผู้ใช้/รหัสผ่านเองใน Terminal ส่วนตัว ตัวช่วยเก็บเฉพาะ session 0600
5. อ่านข้อมูลแล้วให้ดู “เพิ่ม / แก้ / ขัดกัน / ยังไม่ย้าย” และขอเฉพาะการตัดสินใจที่ขาด
   ถ้ามีราคา ถามยืนยันตารางราคาจริงและวันใช้ได้ถึง ไม่ให้ผู้เรียนเขียน config เอง
6. ทำต่อเมื่อมีคำสั่งอนุญาต target+ข้อมูล+เปิดใช้ครบ อ่านกลับแล้วรายงานสถานะจริง

จำคู่เชื่อมใน `~/.config/nongkao-knowledge-sync/pairs/<ชื่อ>.json` (0600) ได้เมื่อผู้เรียนให้จำ
เก็บเฉพาะ target/account/ชื่อร้าน/URL/โฟลเดอร์ starter; ไม่ใส่ token/password
ครั้งต่อไป “ซิงก์ร้านนี้ไปน้องเก้า” ใช้คู่เดิมได้ แต่ตรวจบัญชี/ร้านปัจจุบันทุกครั้ง
การจำคู่เชื่อมไม่ใช่การอนุญาต sync อัตโนมัติถาวร

## ข้อแตกต่างที่ต้องบอกก่อนอนุญาต

- Nongkao ใช้การ์ด `price`; ลูกแพรมี `approved_prices` แยก จึงต้องทำ product mapping
  พร้อมชื่อสินค้า จำนวนเงินจริง และการยืนยัน ไม่คัดลอกราคาเป็นข้อความแล้วบอกว่าเสร็จ
- Nongkao ตัดความรู้หมดอายุออก แต่ starter importer รุ่นนี้ **ไม่ปิดรายการเมื่อหมดอายุอัตโนมัติ**
  ตัวช่วยบล็อกการย้ายการ์ดมีวันหมดอายุจนผู้เรียนยอมรับการทบทวน/ปิดเอง (`acceptManualExpiry`)
  อธิบายตรง ๆ ว่าวันที่ในข้อความไม่ใช่ระบบบังคับ expiry ห้ามตั้ง flag นี้เอง
  ถ้าผู้เรียนต้องการ expiry อัตโนมัติ ให้คงเป็นชุดเตรียมและแจ้งว่าต้องเพิ่มความสามารถปลายทางก่อน
- การ import ฝั่ง starter ใช้ backup/หยุดบริการ/เริ่มบริการตามตัวช่วยเดิม อาจมีช่วงสั้นที่ไม่ตอบ
  ต้องรวมผลนี้ในสรุปที่ขออนุญาต ไม่อ้างว่า zero downtime
- การนำเข้าร้านที่เปิดตอบอัตโนมัติอยู่มีผลต่อคำตอบถัดไป แม้ skill จะไม่ได้ส่งข้อความเอง
- Snapshot เลือกเฉพาะความรู้ที่ active และช่องทางที่ตกลง ไม่คัดลอก private chats, safety rules,
  system prompt หรือข้อมูลทุกร้านใน account โดยอัตโนมัติ

## คำสั่งของ agent (ผู้เรียนไม่ต้องจำ)

ทุก JSON/input/snapshot/staging/receipt อยู่โฟลเดอร์ส่วนตัวนอก Git (0700/0600)
อย่าเก็บในโฟลเดอร์ skill ที่นำไปแจก ตัวอย่าง path เป็น placeholder ให้ใช้ path จริงและ quote

### ลูกแพร → Nongkao

1. `node <skill>/scripts/bridge.mjs console-snapshot https://<ร้าน> <private>/console.json`
   รับเฉพาะ snapshot คลังความรู้/ราคา ไม่มีการส่งข้อความหรือแก้ระบบ
2. Agent สร้าง selection:

```json
{
  "origin": "https://shop.example.com", "username": "learner",
  "label": "ร้านตัวอย่าง", "channelId": null,
  "rows": [{"id":"FROM_SNAPSHOT", "kind":"faq", "tag":"", "source":"เจ้าของร้านตรวจจาก Console", "reviewedOn":"2026-10-09", "validUntil":""}],
  "prices": []
}
```

`channelId:null` คือสมองกลาง เลือกสาขาต้องใช้ ID จริง ห้ามตีความ null = ทุกสาขา
เลือกเฉพาะ ID ที่ผู้ใช้ขอ ตรวจเนื้อหาที่มีราคา/วันเวลาแล้วใช้ kind ให้ถูก ไม่ใช้ general หลบ expiry
`prices` ใช้ `{label,source,reviewedOn,validUntil}` โดย label ตรงตารางราคาจริง
ราคาเป็นรายการกลาง จึงต้องเลือก scope กลางชัดเจน ถ้ามีวันที่/ความยาวเกินข้อจำกัดของ Nongkao
ให้ช่วยสรุป/แบ่งการ์ดพร้อมต้นฉบับให้ตรวจ ไม่ตัดทิ้งเงียบ ๆ และอย่าอ้างว่า lossless
วันที่ตัวอย่างไม่ใช่ค่าเริ่มต้น ใช้วันที่ตรวจจริงที่ผู้เรียนยืนยัน

3. `node <skill>/scripts/bridge.mjs console-bundle <private>/console.json <private>/selection.json <private>/bundle.json`
4. Config: `{cardIds:[...],target:<Nongkao target>,metadata:{},replace:[],includeExistingDraft:false}`
   ใช้ target จาก `sync.mjs shops` และเลือก cardIds จาก bundle รักษาบุคลิกปลายทางโดย default
5. `node <skill>/scripts/bridge.mjs to-nongkao <private>/bundle.json <private>/config.json <private>/input.json`
6. ใช้ `sync.mjs plan` → ตรวจผลและสิทธิ์ → `apply` ตาม SKILL.md เดิม

### Nongkao → AI Admin Starter

1. ตรวจว่ามี local `business/` จริง ไม่ใช้ `business-example` เป็นร้านผู้เรียน
   ถ้าไม่มี ให้ owning setup skill ช่วยตั้งข้อมูลเจ้าของร้านก่อน อย่าสร้าง ownerName สมมติ
   อ่าน API Console และตรวจชื่อธุรกิจ/บัญชีให้ตรงกับ `business.json` ก่อนทุก import
2. `node <skill>/scripts/bridge.mjs nongkao-export <private>/target.json <private>/bundle.json`
   ส่งออกเฉพาะ active version; ร่างยังไม่เปิดใช้ต้องให้ผู้เรียนตรวจและเปิดใช้ก่อนถ้าต้องการย้าย
3. Config ของ agent:

```json
{
  "businessId":"FROM_BUSINESS_JSON", "businessName":"FROM_BUSINESS_JSON",
  "consoleOrigin":"https://shop.example.com", "consoleUsername":"learner",
  "cardIds":["FROM_BUNDLE"], "products":[], "replaceProducts":[], "replaceFiles":[],
  "acceptManualExpiry":false
}
```

การ์ดราคาแต่ละใบต้องมี `products` อย่างน้อยหนึ่งรายการ:
`{cardId,id,name,price,unit,confirmed:true}` โดยราคา/การจับคู่มาจากผู้เรียนยืนยันแล้ว
ถ้าสินค้ามีอยู่แล้ว ใช้ id เดิม ใส่ `replaceProducts:[id]` เฉพาะที่ตกลงให้เปลี่ยน
ถ้าชื่อหัวข้อมีใน knowledge เดิม ใช้ `files:{cardId:"knowledge/ชื่อเดิม.md"}` หลังตรวจความต่าง
และใช้ `replaceFiles` เมื่อผู้เรียนอนุญาตให้แทนที่ของเดิม ไม่สร้างหัวข้อซ้ำเพื่อหลบ conflict

4. `node <skill>/scripts/bridge.mjs stage-starter <private>/bundle.json <starter>/business <private>/config.json <private>/stage`
   สร้างสำเนาทั้ง pack จึงรักษาสินค้า/รูป/FAQ/บุคลิกเดิมไว้ ไม่สร้าง partial pack แล้ว import
5. **ตรวจ source สดก่อน apply**: re-export ต้นทางและเทียบข้อมูล selected cards ถ้าเปลี่ยนให้ rebuild
   รัน `node <skill>/scripts/bridge.mjs check-starter <private>/stage <starter>`
   เพื่อตรวจ VPS target, staged hash, baseHash เทียบ local business และดูรายการ plan ทั้งหมด
6. จากโฟลเดอร์ starter รัน `bash ai-admin.sh import <private>/stage` (dry-run)
   ตรวจ full diff: ต้องไม่มีการปิดการ์ด ถอดราคา หรือเปลี่ยนข้อมูลที่ไม่ได้ขอ
   ถ้ามี live edits จาก Console ที่ local business ยังไม่มี ให้ reconcile ก่อน ไม่ import ทับ
7. เมื่อผู้เรียนอนุญาตให้เปิดใช้ชุดนี้กับ VPS เป้าหมายแล้ว รัน `bash ai-admin.sh import <private>/stage --apply`
   ก่อนหน้านั้นรัน `bash ai-admin.sh status` ตรวจเครื่องและโดเมนที่ VPS รายงานว่าตรง Console ของผู้เรียน
   ผล `check-starter` ตรวจได้แค่ config ในเครื่อง ไม่ใช่หลักฐานว่าปลายทาง VPS ถูกต้องเอง
   ห้ามเพียงเชื่อชื่อโฟลเดอร์หรือไฟล์ `.state.json`
   ใช้ตัวช่วยเดิมเท่านั้น ไม่แก้ SQLite โดยตรง ไม่ใช้ SSH manual ไม่เปิด golive เพิ่ม
8. `node <skill>/scripts/bridge.mjs verify-starter <private>/stage <private>/receipt.json`
   ต้องพบทั้งการ์ด active ตรงกันทุกตัว ราคา approved ตรงกัน และไม่มี knowledge ตกหล่นเพราะเต็ม
9. `node <skill>/scripts/bridge.mjs commit-starter <private>/stage <starter>/business <private>/receipt.json`
   เก็บ preimage ไว้ก่อนและอัปเดตแหล่งข้อมูล local เพื่อไม่ให้ import รอบหน้าทับสิ่งที่เพิ่งเพิ่ม
   หาก local เปลี่ยนระหว่างทาง ให้หยุด reconcile แม้ remote สำเร็จแล้ว ห้ามบอกว่า rollback แล้ว

`brain-bridge-index.json` อยู่ใน business ส่วนตัว ใช้คง metadata เมื่อส่งกลับ:
ก่อน console-bundle อ่าน index แล้วใส่ `preserved:Object.values(index.entries)` ใน selection
ตัวช่วยใช้เฉพาะ row ที่ title+content ตรง index ทุกตัวอักษร จึงไม่ซ้อน source/date footer ซ้ำไปเรื่อย ๆ
ถ้า edited ไม่ตรง ให้จัด metadata ใหม่และให้ผู้เรียนตรวจ ไม่เชื่อข้อมูลเก่าใน index

## เกณฑ์จบและการกู้กรณีค้าง

สถานะฝั่ง starter คือ `starter_store_readback_verified` (คลัง active + ราคา + runtime counters)
ไม่เท่ากับพิสูจน์ว่า AI ตอบลูกค้าถูกทุกสถานการณ์ ใช้ harness ของ starter กับกรณีสินค้า/ราคา/ข้อมูลขาด
หากต้องเรียกโมเดลจริงให้แจ้งค่าใช้จ่ายและใช้ขอบเขตที่ผู้เรียนอนุญาต ไม่ทักลูกค้าจริงเพื่อเทสต์
นำเข้าจริง error/timeout: หยุดอ่าน Console ก่อน retry เพราะรายการอาจเข้าแล้ว ไม่มี auto rollback
ไม่วน sync สองทางเอง ไม่มี background process หรือ scheduler ในแพ็กนี้

สำหรับก่อนสอนจริง: ผู้สอนต้องลองหนึ่งคู่บัญชี/VPS จริงพร้อมผู้เรียนจำลอง ผ่าน login, dry-run,
import, readback, sync กลับ, sync ซ้ำ และตรวจคำตอบผ่าน harness ก่อนเรียกว่า classroom live-verified
