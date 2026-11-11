# การใช้งานตัวช่วย

รองรับ Node.js 22+ บน macOS/Linux (Windows ใช้ WSL) ไม่มี npm dependency
API ปลายทางล็อกเป็น `https://nongkao.tkd-crm.com` ไม่รับ URL จากไฟล์ข้อมูล
รองรับร้านที่ผูกกับ workspace ปัจจุบัน ถ้าเป็นสมาชิกหลาย workspace ให้เลือก workspace
ใน Nongkao ตามปกติแล้วเชื่อม session ให้ตรงก่อน ไม่สลับทีมอัตโนมัติ

## บัญชีและข้อมูลส่วนตัว

`scripts/login.mjs` ให้ผู้เรียนยืนยันส่ง OTP และกรอกรหัสเองใน Terminal
session เก็บที่ `~/.config/nongkao-knowledge-sync/session.json` (0600)
โฟลเดอร์สร้างใหม่เป็น 0700 อย่านำไฟล์นี้ไปแจกหรือเก็บใน Git/cloud shared folder
ใช้บัญชีผู้เรียนที่มีอยู่แล้ว เพราะการลงชื่อเข้าใช้เมลใหม่อาจสร้างบัญชี Nongkao
เมื่อหมดอายุ ให้ย้ายไฟล์ session เก่าไปสำรองส่วนตัว แล้วรัน login ใหม่
ห้ามย้าย/ลบไฟล์ session ของผู้เรียนโดยไม่ขอ ออกอุปกรณ์ได้ในหน้าบัญชี Nongkao
การลบไฟล์ในเครื่องไม่ใช่การเพิกถอน session บนเซิร์ฟเวอร์
ตัวช่วยรับ `NONGKAO_SESSION_TOKEN` จาก secret store/env ที่ผู้ใช้ตั้งไว้อยู่แล้วด้วย
ไม่ใส่ token เป็น argument ไม่ print env ไม่คัดลอก token จาก browser ออกมาในแชต

## รูปแบบ input ที่ agent สร้าง

ข้อมูลต่อไปนี้เป็นร้านและข้อมูลสมมติ ห้ามนำเข้า production:

```json
{
  "target": {
    "accountId": "FROM_SHOPS_COMMAND",
    "actor": "learner@example.com",
    "platform": "line",
    "oaId": "FROM_SHOPS_COMMAND",
    "shopName": "ร้านตัวอย่าง"
  },
  "metadata": { "businessName": "ร้านตัวอย่าง" },
  "cards": [{
    "kind": "faq",
    "tag": "การดูแลสินค้า",
    "title": "วิธีเก็บสินค้า",
    "content": "เก็บให้พ้นแสงแดดตามฉลากสินค้า",
    "source": "ผู้เรียนยืนยันในแชตงานนี้",
    "reviewedOn": "2026-10-09",
    "validUntil": ""
  }],
  "replace": [],
  "includeExistingDraft": false
}
```

วันที่ในตัวอย่างไม่ใช่ค่าตั้งต้น ใช้วันตรวจจริง รูปแบบ YYYY-MM-DD ปี ค.ศ.
`metadata` เปลี่ยนเฉพาะฟิลด์ที่ผู้ใช้ขอ: businessName, assistantName, tone,
businessType, businessTypeCustom; ร้านใหม่ใช้ businessType เดิม `other` ได้
อย่าเดาค่า businessType enum ให้เก็บของเดิมและใช้ businessTypeCustom เมื่อผู้ใช้ระบุธุรกิจ
`replace` เป็นรายการ `{kind, tag, title}` ของการ์ดที่ผู้ใช้เลือกให้แทนที่ชัดเจน
ไม่มีโหมดลบการ์ด ตัวช่วยบล็อกข้อมูลชนกันและร่างเดิมที่ยังไม่ได้ตรวจ

Limits: 60 การ์ดรวม, title 150, tag 60, content 5,000, source 500 ตัวอักษร,
knowledge JSON 150,000 ตัวอักษร ห้ามตัดเนื้อหาเงียบ ๆ ถ้าเกินให้ช่วยสรุปและให้ตรวจ
บันทึกร่างที่ขาดวันหมดอายุได้ แต่เปิดใช้ไม่ได้ ต้องแจ้งสถานะกับผู้เรียน

## คำสั่ง

แทน `<skill-dir>` ด้วยโฟลเดอร์ skill ที่ติดตั้ง ใช้ path ที่ quote ถูกต้อง
ใช้โฟลเดอร์งานส่วนตัวนอก Git เช่น `~/.local/share/nongkao-knowledge-sync/jobs/<job>/`
สร้างโฟลเดอร์ 0700 และไฟล์ input 0600 อย่าใช้ /tmp ชื่อคงที่หรือเก็บข้อมูลร้านใน skill

```sh
node <skill-dir>/scripts/sync.mjs shops
node <skill-dir>/scripts/sync.mjs plan <private>/input.json draft <private>/plan.json
# หรือ mode live เมื่อขอเปิดใช้ ต้องผ่าน validation และตรวจทั้งชุดก่อน
node <skill-dir>/scripts/sync.mjs apply <private>/plan.json <approved-plan-id> <private>/receipt.json
```

plan ทำการอ่าน API ไม่บันทึกความรู้ แต่ `/me` ของ Nongkao อาจทำ settlement/mission
ภายในตามพฤติกรรมระบบเดิม และทุก authenticated request touch session ปกติ
`apply` เป็นการเขียนจริง ต้องมีคำสั่งผู้เรียนอนุญาต target+ชุดข้อมูล+mode นี้
plan ID ผูก candidate กับ revision และ target ไม่ใช่หลักฐานว่าได้รับอนุญาตเอง
ไฟล์ output ต้องยังไม่มีอยู่เพื่อป้องกันทับงานเก่า

คำสั่ง shops ส่งคืน actor (คนที่ล็อกอิน) แยกจาก accountId (workspace ของร้าน)
ถ้าร้านยังไม่มีชื่อ displayName จะแสดง platform:oaId ให้ผู้เรียนระบุว่าเป็นช่องทางที่ต้องการ
ใช้ displayName นี้เป็น target.shopName และใช้ชื่อธุรกิจที่ผู้เรียนให้ใน metadata.businessName
ตัวช่วยตรวจว่าร้านมีใน `/me` ก่อนเรียก knowledge-read เพราะ API เดิมสามารถผูกร้านใหม่
เมื่อเจอรหัสที่ยังไม่รู้จัก จึงห้ามใช้ oaId ที่เดา/สร้างขึ้นเอง

## API contract และผลลัพธ์

- GET `/me`, GET `/team` เมื่อมี team: ตรวจคนที่ล็อกอิน workspace ช่องทาง และ teach
- POST `/knowledge/knowledge-read`: `{platform,oaId}` → `{ok,knowledge}`
- POST `/knowledge/knowledge-version`: เพิ่ม `versionId` → `knowledge.draft`
- POST `/knowledge/knowledge-save`: เพิ่ม `revision,draft` → revision เพิ่ม 1
- POST `/knowledge/knowledge-publish`: เพิ่ม `revision,confirmed:true` → activeVersion ใหม่
- POST `/auth/otp`, `/auth/verify`: ใช้เฉพาะ interactive login ที่ผู้เรียนอนุญาต

`draft_readback_verified` = ร่างอ่านกลับตรงกัน; activeVersion เดิมยังอยู่
`published_readback_verified` = ทั้งร่างและ active version อ่านกลับตรง candidate
`previousActiveVersion` ใน receipt ใช้ช่วยตรวจย้อนหลัง การ rollback ไม่ได้ทำอัตโนมัติ
ไม่มี auto-retry การเขียน เมื่อผลไม่แน่ชัดให้อ่านของจริงก่อน ถ้าบันทึกไปแล้วแต่ยังไม่เปิดใช้
ต้องบอกว่า “บันทึกร่างแล้ว ยังเปิดใช้ไม่สำเร็จ” ไม่รายงานรวมว่าไม่เกิดอะไรขึ้น

## การทดสอบในแพ็ก

`node --test <skill-dir>/tests/*.test.mjs` ใช้ข้อมูลสมมติและ in-memory API
ไม่ขอ OTP ไม่ใช้บัญชีจริง ไม่เรียก AI และไม่ส่งข้อความลูกค้า
การทดสอบกับ backend source จริงทำแยกโดยผู้ดูแลแพ็ก ไม่จำเป็นสำหรับนักเรียน
