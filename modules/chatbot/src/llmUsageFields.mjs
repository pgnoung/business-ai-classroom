// llmUsageFields.mjs — อ่านตัวเลข usage จาก provider ให้เป็นรูปเดียวที่ db.addLlmUsage รับ
//
// ทำไมต้องมีไฟล์นี้ (31 ส.ค. 2026): ตัวเขียน llm_usage มี 4 จุด และ 2 จุด (staged_followup,
// followup) ลืมส่ง cachedIn ทั้งที่เครื่องคิดเงินอ่านช่องนั้นแล้ว ผลคือรายงานต้นทุนของสองเส้นนั้น
// แพงเกินจริงถึง ~2.7 เท่า เพราะถูกคิดเป็นราคาเต็มทั้งก้อน ทั้งที่ของจริงโดนแคชไปแล้ว
// จุดร่วมเดียวแปลว่าตัวเขียนรายที่ 5 จะไม่พลาดซ้ำอีก
//
// รองรับชื่อฟิลด์ทั้งสองแบบที่ผู้ให้บริการใช้ (chat completions / responses API)
export function usageFields(usage = {}) {
  const tokensIn = Math.max(0, Number(usage?.prompt_tokens ?? usage?.input_tokens) || 0);
  const cachedRaw = Math.max(0, Number(
    usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens
  ) || 0);
  const cacheWriteRaw = usage?.prompt_tokens_details?.cache_write_tokens ?? usage?.input_tokens_details?.cache_write_tokens;
  return {
    tokensIn,
    tokensOut: Math.max(0, Number(usage?.completion_tokens ?? usage?.output_tokens) || 0),
    // แคชมากกว่ายอด input จริงไม่ได้ — ตัวเลขเพี้ยนจาก provider ห้ามทำให้บิลติดลบ
    cachedIn: Math.min(cachedRaw, tokensIn),
    // Missing old receipts stay missing; never invent historical cache writes.
    ...(cacheWriteRaw == null ? {} : { cacheWriteIn: Math.min(Math.max(0, Number(cacheWriteRaw) || 0), tokensIn - Math.min(cachedRaw, tokensIn)) }),
  };
}
