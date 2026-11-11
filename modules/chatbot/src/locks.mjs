// locks.mjs — เครื่องมือกันงานซ้อน (SPEC ข้อ 5: ทุก background loop ต้องมี synchronous lock)

// lock แบบ synchronous สำหรับ loop เดี่ยว เช่น canary probe
// ใช้คู่กับ try/finally เสมอ: if (!lock.tryAcquire()) return; try {...} finally { lock.release(); }
export function createLock() {
  let held = false;
  return {
    tryAcquire() {
      if (held) return false;
      held = true;
      return true;
    },
    release() {
      held = false;
    },
    get held() {
      return held;
    },
  };
}

// คิวต่อ key: งานของลูกค้าคนเดียวกันวิ่งทีละงานตามลำดับ (กัน reply ซ้อนกัน
// เวลา burst ที่สองมาถึงระหว่างรอ Hermes ของ burst แรก) — คนละ key วิ่งขนานได้
export function createKeyedQueue() {
  const tails = new Map();
  return {
    run(key, fn) {
      const k = String(key);
      const prev = tails.get(k) ?? Promise.resolve();
      const next = prev.then(() => fn());
      // เก็บ tail แบบไม่ reject เพื่อไม่ให้ error งานก่อนหน้า block งานถัดไป
      const tail = next.catch(() => {});
      tails.set(k, tail);
      tail.then(() => {
        if (tails.get(k) === tail) tails.delete(k);
      });
      return next;
    },
    pending(key) {
      return tails.has(String(key));
    },
    size() {
      return tails.size;
    },
    // รอจนไม่มีงานค้างเลย — เรียกได้เฉพาะ "หลังปิดปากทางเข้าแล้ว" เท่านั้น
    // ไม่งั้นงานใหม่ไหลเข้ามาเรื่อย ๆ แล้วไม่มีวันจบ
    //
    // ต้องแข่งกับนาฬิกาเสมอ ห้าม await งานเปล่า ๆ แล้วค่อยเช็คเส้นตาย:
    // งานที่ค้างจริง (Hermes ไม่ตอบ) จะไม่ settle เลย เส้นตายจึงไม่มีวันถูกตรวจ
    // แล้วเฟส "ปิดจริง" ไม่มีวันมาถึง — เหลือแค่ตัวจับเวลาบังคับปิดที่รออีกหลายวินาที
    async idle({ deadlineAt = Infinity } = {}) {
      while (tails.size) {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) return false;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, Math.min(remainingMs, 100));
          timer.unref?.();
          Promise.allSettled([...tails.values()]).then(() => { clearTimeout(timer); resolve(); });
        });
      }
      return true;
    },
  };
}
