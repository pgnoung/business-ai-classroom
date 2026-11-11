// shutdown.mjs — ปิดให้จบเทิร์น (Drain-to-Finish)
//
// เพดาน 3 วินาทีเดิมคือมือสังหารตัวจริงของบั๊ก "ห้องเงียบถาวรตอน deploy":
// มันสั้นกว่าหน้าต่าง burst เสมอ (default 4-12 วิ, เครื่องจริงตั้ง 10-60 วิ)
// และ server.close() callback ยิงทันทีเพราะ webhook ตอบ 200 ไปแล้ว
// => deploy ทุกครั้ง = ยิงกลางหน้าต่าง debounce พอดี
//
// ตัวประสานนี้ไม่ "ลองใหม่" อะไรทั้งสิ้น มันแค่ให้เวลางานที่เริ่มไปแล้วปิดตัวเองให้จบ
// งานที่จบไม่ทันถูกปักธงไว้บนดิสก์ให้คนรับต่อ — ไม่มีเส้นทางไหนส่งข้อความซ้ำ
import { flagNeedsHumanForTurn, strandedHandoffMessage } from "./inboundOutcome.mjs";

export function createShutdownCoordinator({
  app, db, config, logger = console, processId = "",
  setDraining = () => {},
  exit = (code) => process.exit(code),
}) {
  let started = false;
  let hardTimer = null;

  function clearHardTimer() {
    if (hardTimer) { clearTimeout(hardTimer); hardTimer = null; }
  }

  // ปิดแบบไม่เรียบร้อย: เทิร์นที่ยังค้างถูกปิดเป็นสถานะสุดท้ายตรงนี้ แปลว่าตัวกวาดตอนบูต
  // รอบหน้า (ซึ่งมองเฉพาะ owed/sending) จะไม่มีวันเห็นแถวพวกนี้อีกเลย
  // ธงต้องถูกปักที่นี่ให้ครบ ไม่งั้นเส้นทางที่ฟีเจอร์นี้ถูกสร้างมาแก้พอดี — deploy แล้ว
  // drain ไม่ทัน — จะจบลงด้วยแถวในตารางที่ไม่มีใครอ่าน เหมือนเดิมทุกประการ
  // (ที่กลับหัวยิ่งกว่าคือ ตายแบบ SIGKILL กลับได้ผลดีกว่า เพราะแถวค้าง owed ให้บูตเก็บได้)
  function strandAndFlag() {
    const stranded = db.strandOpenTurnsForProcess(processId);
    for (const turn of stranded.rows || []) {
      const status = turn.status === "sending" ? "stranded_ambiguous" : "stranded_shutdown";
      const flagged = flagNeedsHumanForTurn(db, turn.customer_id, {
        reason: status, message: strandedHandoffMessage(status), logger,
      });
      if (!flagged) continue;   // ห้องที่ปิด AI อยู่แล้ว = ของคนจริงอยู่แล้ว ไม่ต้องส่งเสียง
      try {
        db.addAudit({
          operator: "system", action: `inbound_turn_${status}`,
          target: turn.customer_id, detail: "ระบบถูกบังคับปิดขณะเทิร์นยังไม่จบ",
        });
      } catch { /* audit ล้มไม่กระทบธงที่ปักไว้แล้ว */ }
    }
    return stranded;
  }

  function forceExit() {
    clearHardTimer();
    try {
      const stranded = strandAndFlag();
      if (stranded.owed || stranded.sending) {
        logger.error?.(`[chassis] hard exit: เทิร์นค้าง owed=${stranded.owed} sending=${stranded.sending} — ปักธงให้คนรับต่อแล้ว`);
      }
    } catch (err) {
      logger.error?.(`[chassis] hard exit: ปักธงเทิร์นค้างไม่สำเร็จ (${err?.message || err})`);
    }
    try { db.close(); } catch { /* ปิดไม่ได้ก็ต้องออก */ }
    return exit(0);
  }

  async function run(signal) {
    if (started) return;            // SIGTERM ครั้งที่สองไม่เริ่ม drain ใหม่
    started = true;
    const startedAt = Date.now();
    logger.log?.(`[chassis] กำลังปิด (${signal}) — drain ${config.shutdownDrainMs}ms`);

    // เฟส 0: ปิดปากทางเข้า (synchronous ทันที)
    setDraining(true);
    app.canary.stop();
    app.followups.stop();
    app.stagedFollowups.stop();
    app.retention.stop();
    app.needsHumanSla?.stop();
    app.pauseResume?.stop();
    app.brainParity?.stop(); // Phase 1a: ตัวเฝ้าสมองเงา (timer + รอบแรกหลังบูต)
    app.digest.stop();
    app.hotFollowupPush?.stop();
    app.qualifySweep?.stop(); // 5 ต.ค. 2026: ตัวกวาดคัดกรอง — ไม่เริ่มรอบใหม่ระหว่างปิด (รอบที่เดินอยู่เห็น isDraining เอง)
    app.ownerReviewScheduler?.stop(); // 12 ต.ค. 2026 ค่ำ: รอบตรวจของพี่ง้วง — หยุดระหว่างห้อง (isDraining) ทำต่อหลังบูตจาก cursor
    app.adThumbs?.stop();
    app.metaCapi?.stop?.(); // 7 ต.ค. 2026: ไม่เริ่มรอบส่ง Meta ใหม่ระหว่างปิด // 6 ต.ค. 2026: ตัวเก็บรูปแอด — ไม่โหลด/เขียนรูปหลังเริ่มปิด (db กำลังจะปิด)
    app.learning.stop();
    app.broadcastScheduler?.stop();
    app.telegramControl?.stop(); // 2026-09-28: หยุด long poll ของ Telegram (ยกเลิกคำขอที่ค้างอยู่ทันที)
    app.lineInsight?.stop(); // 28 ก.ย. 2026: ตัวดึงสถิติรายวันของ LINE
    app.stepMessages?.stop(); // 28 ก.ย. 2026: ข้อความตามขั้น
    app.blueprintSender?.stop(); // 11 ต.ค. 2026: แคมเปญ #AIAGENT — ไม่เริ่มรอบสร้าง/ส่งใหม่ระหว่างปิด
    app.pipeline.beginDrain({ deadlineAt: startedAt + config.shutdownDrainMs });

    hardTimer = setTimeout(forceExit, config.shutdownHardExitMs);
    hardTimer.unref?.();

    // เฟส 1: flush burst แบบไม่รอ debounce
    // ปลอดภัยแล้วเพราะทุกเทิร์นที่ค้างมีแถวบัญชีถาวรรออยู่บนดิสก์
    try {
      const flushed = app.burst.flushAll();
      logger.log?.(`[chassis] drain: flush burst ${flushed} ห้อง — ไม่รอ debounce`);
    } catch (err) { logger.warn?.(`drain flush ล้ม: ${err?.message || err}`); }

    // เฟส 2: เส้นตายของการคิด — ยกเลิกเฉพาะ draft ที่ยังไม่ถึงจุดส่ง
    //
    // ต้องเป็นตัวจับเวลา "วนซ้ำ" ไม่ใช่ยิงครั้งเดียว: เทิร์นเสียง/รูปต้องดาวน์โหลด+ถอดความ
    // หรือเรียกตัวจำแนกก่อน draft จึงเริ่มทีหลังเส้นตายได้ ถ้ายิงครั้งเดียว draft ที่เกิด
    // หลังจากนั้นจะไม่ถูกยกเลิกเลย แล้วคิดยาวไปจนโดน hard exit
    const abortAt = startedAt + Math.max(0, Number(config.shutdownDraftAbortMs) || 0);
    const abortTimer = setInterval(() => {
      if (Date.now() < abortAt) return;
      try { app.pipeline.abortDraftsNotSending(); }
      catch (err) { logger.warn?.(`drain abort ล้ม: ${err?.message || err}`); }
    }, 250);
    abortTimer.unref?.();

    // เฟส 3: รอคิวว่าง แบบมีเพดาน
    let drained = false;
    try {
      drained = await app.pipeline.idle({ deadlineAt: startedAt + config.shutdownDrainMs });
    } catch (err) {
      logger.warn?.(`drain idle ล้ม: ${err?.message || err}`);
    }
    clearInterval(abortTimer);
    logger.log?.(`[chassis] drain: ${drained ? "คิวว่างแล้ว" : "หมดเวลา"} (${Date.now() - startedAt}ms)`);

    // เฟส 4: ปิดจริง
    if (!drained) return forceExit();
    // ห้าม clearHardTimer() ตรงนี้ — server.close() เรียก callback ต่อเมื่อ "ทุก connection
    // ปิดหมด" แล้วเท่านั้น แอดมินที่เปิดดูวิดีโอ/ไฟล์แนบของลูกค้าค้างไว้บนเน็ตช้าจะทำให้
    // callback ไม่มาเลย ถ้าปลดตัวจับเวลาไปก่อน โปรเซสค้างจนกว่า systemd จะ SIGKILL
    // (ซึ่งข้าม strandAndFlag ทั้งบล็อก + deploy ช้าไปเป็นนาที)
    // โค้ดเดิมมี setTimeout(3000) เป็นกลอนสำรองไว้ ตอนนี้ hardTimer ทำหน้าที่นั้นแทน
    app.server.close(() => {
      clearHardTimer();
      try { db.close(); } catch { /* ปิดไม่ได้ก็ต้องออก */ }
      exit(0);
    });
  }

  return { run };
}
