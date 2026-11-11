# ชุดผู้เรียนเทียบกับ Console ลูกแพร

ตรวจฐานที่ใช้งานจริงวันที่ 12 พ.ย. 2026; source commit `4316f979e75b9197b7bba1b4ac6d6c5618a6831b`

| ส่วน | repo ก่อนอัปเดต | repo รุ่นนี้ |
|---|---|---|
| Chassis + Console | ฐานเดียวกับรุ่นจริง ปรับเป็นธุรกิจทั่วไป | ฐานเดิม: แชต คลัง สินค้า ออเดอร์ แท็ก ส่งต่อคน บรอดแคสต์ |
| AI Gateway | เรียก OpenAI ตรงจากตัวติดตั้ง | เพิ่ม Gateway จากรุ่นจริง แยก process และคีย์ |
| เลือกโมเดล | มีหน้าตั้งค่า แต่ทางติดตั้งไม่ครบ Claude | เลือกตอบแชต/ประเมิน/ติดตาม เชื่อม OpenAI และ Claude |
| คีย์สำรอง | ไม่มีในขั้นติดตั้ง | OpenAI สองชุด และ Claude สองชุด |
| โมเดลสำรอง | ขึ้นกับการเรียกตรง | Claude → OpenAI เมื่ออยู่ในรายการอนุญาต |
| ติดตั้ง VPS | Console service | Console + Gateway ใน release เดียว มี config migration |
| หลักฐานก่อนเปิด LINE | ทดลองแชต | เพิ่ม model-test ของโมเดลที่เลือกก่อนเปิด LINE |

## ส่วนที่ตั้งใจแยกจากระบบของครู

- ไม่มี brain/ข้อมูลธุรกิจ บัญชี คีย์ ประวัติแชต ฐานข้อมูล หรือโดเมนของลูกแพร: ใช้ของเจ้าของร้านเอง
- งานขายคอร์สและกติกาเฉพาะลูกแพรใช้ generic business profile แทน ไม่เปิดระบบเฉพาะร้านโดยไม่ตั้งค่า
- ไม่รวม mirror เก็บสำเนาคำถาม/คำตอบเพื่อวิจัยภายใน หรือเครื่องมืออ่านฐานข้อมูลส่วนตัว
- ตัวติดตั้ง learner และหลักฐาน model-test เป็นส่วนที่ปรับใหม่; ไม่ใช่การคัดลอก private deployment/attestation ของ production
- VPS ของครูมี Caddy/Cloudflare tunnel; ตัวติดตั้งนักเรียนใช้ Caddy + HTTPS ของโดเมนผู้เรียน ไม่สร้าง Cloudflare tunnel ให้อัตโนมัติ
- Facebook/Telegram/ชำระเงินต้องตั้งค่าและทดสอบแยก; JST/stock ยังไม่มี connector สำเร็จ
- น้องเก้าและ Content Studio คงอยู่ในแพ็ก แต่เป็นโมดูลแยกที่ต้องเชื่อมบัญชีและตรวจจริงตามขั้นเรียน

Stack หลัก: Node.js 22, JavaScript ESM, Console HTML/CSS/JavaScript, SQLite WAL, LINE Messaging API, Gateway OpenAI/Anthropic, Ubuntu VPS, systemd และ Caddy HTTPS
Hermes Agent ไม่ใช่ตัวรับส่งแชตของ Console ชุดนี้ ชื่อ HERMES_* ใน config เป็นชื่อที่ใช้สืบต่อมา

ผลตรวจใน VALIDATION.md เป็นผล local/mock-provider; ยังไม่เท่ากับติดตั้ง VPS หรือเรียกโมเดลด้วยบัญชีของผู้เรียนสำเร็จ
