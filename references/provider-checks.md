# ตรวจผู้ให้บริการก่อนเปิดจริง

ตรวจเอกสารวันที่ 11 พฤศจิกายน 2026; ไม่ใช่หลักฐานสิทธิ์บัญชีผู้เรียน

- OpenAI ระบุ model IDs gpt-6.1-sol และ gpt-6-luna ใน [Model catalog](https://developers.openai.com/api/docs/models) แต่ยังต้องทดสอบการเรียกจริงจากบัญชีที่ได้รับอนุญาต
- LINE ต้องตรวจลายเซ็น webhook ก่อนประมวลผล ตาม [Verify webhook signature](https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/)
- หน้าเข้า Nongkao ตอบ HTTP 200 ในการตรวจครั้งนี้; ไม่ได้ login หรือพิสูจน์สิทธิ์ teach ของผู้เรียน
