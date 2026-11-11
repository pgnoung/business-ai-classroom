# แก้ปัญหา (ดูหลักฐานก่อนเดาเสมอ: `ai-admin status`, `ai-admin logs 120`)

| อาการ | สาเหตุที่พบบ่อย | ทำอย่างไร |
| --- | --- | --- |
| `check` บอกไม่มี ssh/scp (Windows) | ยังไม่ได้เปิด OpenSSH Client | Settings → System → Optional features → Add → OpenSSH Client (ผู้ใช้กด) แล้วเปิดหน้าต่างใหม่ |
| PowerShell บอก running scripts is disabled | Execution policy | ใช้ `powershell -ExecutionPolicy Bypass -File ai-admin.ps1 <คำสั่ง>` |
| `connect` ออกรหัส 4 | ยังไม่ได้ส่งกุญแจ | ผู้ใช้รัน `key-upload` |
| `key-upload` ถามรหัสแล้วไม่ผ่าน | รหัส root ผิด / ผู้ให้บริการปิดล็อกอินรหัสผ่าน | รีเซ็ตรหัส root ในแผงผู้ให้บริการ หรือวางไฟล์ `~/.ssh/ai_admin_vps.pub` ในช่อง SSH key ของแผงแล้ว `connect` ใหม่ |
| `connect` ค้าง/timeout | IP ผิด, เครื่องยังไม่พร้อม, พอร์ต 22 ถูกปิด | เช็ก IP · รอ 2–3 นาที · เปิดพอร์ต 22 ในไฟร์วอลล์ของแผง |
| `REMOTE HOST IDENTIFICATION HAS CHANGED` | สร้าง VPS ใหม่ที่ IP เดิม | `ssh-keygen -R <IP>` แล้ว `connect` ใหม่ |
| deploy ผ่าน แต่เปิด https ไม่ได้ | ใบรับรองกำลังออก / พอร์ต 80-443 ถูกปิดที่แผง / DNS โดเมนยังไม่ชี้ | รอ 2 นาทีแล้ว `status` · เปิดพอร์ตในแผง · ใช้ sslip ก่อนถ้าโดเมนยังไม่พร้อม |
| `chat` ไม่มีคำตอบ | ไม่ได้ใส่ OpenAI key / เครดิตหมด / ห้องถูกส่งให้คน | `status` ดูว่าใส่คีย์ไหม · `logs` หา "hermes" หรือ 401/429 · เปิด console ดูห้องทดสอบ ถ้า "ต้องการคน" กดเปิด AI กลับ |
| AI ตอบ "ขอเช็กกับทีมก่อน" บ่อย | ไม่มีข้อมูลเรื่องนั้นใน `business/` หรือไม่มีราคาในรายการ | เพิ่มข้อมูล/ราคา แล้ว `import --apply` |
| AI ไม่บอกราคาบางตัว | สินค้านั้น `price: null` หรือชื่อไม่ตรง | ใส่ราคา หรือเพิ่ม `aliases` |
| `line` บอก 403 | Channel secret ไม่ตรงกับ channel | `secrets` ใส่ secret ใหม่ |
| `line` บอก 401 | Access token ผิด/หมดอายุ/ถูก Issue ใหม่ | Issue ใหม่แล้ว `secrets` |
| ลูกค้าได้คำตอบซ้อนสองชุด | Auto-response ใน OA Manager ยังเปิด | ปิด Auto-response |
| ทักใน LINE แล้วเงียบ | `golive` ยังปิด / Webhook ใน OA Manager ยังปิด | `status` ดู "ส่ง LINE จริง" · เปิด Webhook · `line --check` |
| อัปเดตแล้วพัง | เวอร์ชันใหม่มีปัญหา | `rollback` แล้วแจ้งผู้ดูแลชุด |
| ลืมรหัส console | — | ผู้ใช้รัน `owner` ตั้งใหม่ (ชื่อผู้ใช้เดิม) |

ถ้ายังไม่หาย: เก็บผล `status` + `logs 200` (ตรวจว่าไม่มีโทเคน/ข้อมูลลูกค้าก่อนส่งต่อ) แล้วติดต่อผู้สอนที่ LINE OA @pngoung
