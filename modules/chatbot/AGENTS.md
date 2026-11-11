# AI Admin Starter — คู่มือสำหรับ AI agent

- งานติดตั้ง/ดูแล/เพิ่มข้อมูลร้าน: อ่านและทำตาม `.agents/skills/ai-admin-setup/SKILL.md` (Claude: `.claude/skills/ai-admin-setup/SKILL.md`)
- เทรน/แก้คำตอบ: `ai-admin-training` · จำลองแชทเป็นชุด: `chat-harness` · สกัดแชทเก่าจาก LINE OA: `line-oa-chat-export`
- ทุกการสั่งงาน VPS ผ่าน `bash ai-admin.sh <คำสั่ง>` (Windows: `powershell -ExecutionPolicy Bypass -File ai-admin.ps1 <คำสั่ง>`) — ห้ามแก้ไฟล์บน VPS ด้วยมือ
- ค่าลับไม่ผ่านแชท · ไม่จ่ายเงินแทน · ไม่แต่งราคา · ถามก่อน `golive on`
- ข้อมูลร้านอยู่ใน `business/` (แม่แบบ `business-example/`) · `backups/` และ `starter/.state.json` ห้าม commit/แชร์

## แก้โค้ดระบบ (สำหรับคนที่อยากต่อยอด)
- Node 22 ไม่มี dependency (`node:sqlite`) · เริ่มที่ `src/server.mjs` · หน้า console อยู่ `public/console/`
- เทสต์: `node --test` ต้องผ่านทั้งหมดก่อน deploy · ห้ามรันชุดเทสต์สองชุดพร้อมกัน
- กติกาที่ห้ามลบ: AI ตอบความจริงเมื่อถูกถามว่าเป็นบอทไหม · ราคามาจากรายการที่อนุมัติเท่านั้น · ส่ง LINE จริงต้องเปิดเอง (fail-closed)
