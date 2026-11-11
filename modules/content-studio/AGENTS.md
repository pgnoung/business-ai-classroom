# AGENTS.md · Content Studio (ชุดนักเรียน)

> **เริ่มที่นี่ก่อน:** ถ้าเจ้าของพิมพ์ "เริ่ม" / "ติดตั้ง" / "start" / "ทำต่อ" หรือเพิ่งแตก zip มาเปิดครั้งแรก
> ให้ทำตาม **`INSTRUCTOR.md`** (ครู AI: ถามทีละข้อ · ใส่ข้อมูลร้านจริง · พาประกอบ Make · ทดสอบ · โพสต์แรก)
> และอ่าน/อัปเดต **`PROGRESS.md`** ทุกครั้ง · ไฟล์นี้คือกติกาไฟล์ที่ใช้ระหว่างทาง

## ระบบนี้คืออะไร

เว็บไฟล์เดียว (`webapp/studio.html`) เป็นรีโมท · เครื่องยนต์คือ Make scenario 1 ตัว (`blueprints/studio.json`)
Webhook → Router 7 ทาง แยกตามช่อง `action`: `ping` · `caption` (OpenAI gpt-4.1) · `image` ×4 (OpenAI gpt-image, 0–3 รูปอ้างอิง) · `post` (Facebook Pages โพสต์รูป / ตั้งเวลา)

## แผนผังโฟลเดอร์

```
INSTRUCTOR.md            ลำดับการสอน Stage 0–5 + แก้ปัญหา
PROGRESS.md              จำว่าทำถึงไหน (ติ๊กทีละข้อ)
START_HERE_TH.md         หน้าแรกสำหรับคน 1 หน้า
SKILL.md                 ใช้เมื่อติดตั้งชุดนี้เป็น skill
blueprints/studio.json   ไฟล์ Import เข้า Make (ไม่มี id บัญชีใด ๆ)
webapp/studio.html       เว็บต้นฉบับ (HTML + CSS + JS ในไฟล์เดียว ไม่มี build)
examples/                ตัวอย่างข้อมูลร้าน
tools/personalize.py     สร้าง my-studio.html จาก my-shop.json (python3 ไลบรารีมาตรฐาน)
tools/build_blueprints.py  ต้นฉบับของ studio.json (แก้ blueprint ที่นี่ แล้วรันใหม่)
tests/                   test_kit.py (python3 -m unittest) + mock_make.py (Make จำลอง)
my-shop.json my-studio.html   ไฟล์ส่วนตัวของนักเรียน (สร้างระหว่างเรียน ห้ามแชร์)
```

## กติกา

1. ไม่มี build step ไม่มี npm install · เว็บต้องเปิดได้ด้วยดับเบิลคลิก (`file://`) และเรียก Make ตรงด้วย `fetch` แบบ form-urlencoded
2. ห้ามแก้ `webapp/studio.html` และ `blueprints/studio.json` ต้นฉบับระหว่างสอน · ปรับร้านใน `my-studio.html` และใน Make
3. ชื่อช่องที่เว็บส่ง กับ `{{1.ช่อง}}` ใน Make ต้องตรงกัน (ตาราง action ใน `INSTRUCTOR.md`) · เปลี่ยนฝั่งเดียว = พัง
4. ข้อความจาก AI แสดงด้วย `textContent` เท่านั้น ห้าม `innerHTML`
5. ห้ามใส่ API key, รหัสผ่าน, token ในไฟล์ใด ๆ · key อยู่ใน connection ของ Make
6. `my-studio.html` มีลิงก์ Make ของนักเรียน = ห้ามขึ้น git สาธารณะ เว็บสาธารณะ หรือไดรฟ์แชร์ (`.gitignore` กันไว้แล้ว)
7. ทุกเส้นใน Make ต้องจบด้วย Webhook response ที่มี `Access-Control-Allow-Origin: *` และกล่องที่พังได้ต้องมี error handler ตอบ `{"ok":false,"error":"…"}` แล้ว Ignore
8. motion ใช้ transform/opacity · เคารพ `prefers-reduced-motion` · ปุ่ม ≥ 44px บนมือถือ

## รันและทดสอบ

```bash
python3 -m unittest discover -s tests -v     # ตรวจ blueprint กับเว็บให้ตรงกัน ไม่ยิง Make
python3 tools/build_blueprints.py --check    # studio.json ตรงกับต้นฉบับ
python3 tests/mock_make.py                   # Make จำลอง → http://127.0.0.1:5480/webapp/studio.html หรือ /my-studio.html (ลิงก์ http://127.0.0.1:5480/hook)
```
