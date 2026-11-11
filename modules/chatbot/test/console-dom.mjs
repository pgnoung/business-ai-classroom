// DOM จำลองสำหรับรัน "หน้าเว็บจริง" ในเทสต์
//
// ทำไมต้องมี (บทเรียน 2026-08-26): เทสต์ 1417 ตัวที่มีอยู่ ไม่มีตัวไหนเรนเดอร์หน้าเว็บเลย
// ที่มีคืออ่านซอร์สเป็นข้อความแล้ว match ด้วย regex กับทดสอบ API ฝั่งเซิร์ฟเวอร์
// ส่วน `node --check` ตรวจแค่ไวยากรณ์ ไม่ได้รันโค้ด
// ผลคือ `roomData is not defined` (อ้างตัวแปรผิดชื่อ) หลุดขึ้น production
// และคนแรกที่เจอคือพี่ง้วงตอนกดเข้าห้องแชท
//
// ตัวนี้ไม่ได้พยายามเป็นเบราว์เซอร์ — แค่สมจริงพอให้โค้ดเรนเดอร์เดินจนจบ
// เพื่อจับ ReferenceError / TypeError ที่การอ่านซอร์สจับไม่ได้

function matchesSelector(node, selector) {
  const parts = String(selector).trim().split(/\s+/u);
  const last = parts[parts.length - 1];
  return last.split(",").some((one) => {
    const token = one.trim();
    if (!token) return false;
    if (token.startsWith("#")) return node.attributes?.id === token.slice(1);
    if (token.startsWith("[") && token.endsWith("]")) {
      const key = token.slice(1, -1).split("=")[0];
      return Object.hasOwn(node.attributes || {}, key);
    }
    // รองรับ tag, .class และ tag.class.class ผสมกัน
    const [tagPart, ...classParts] = token.split(".");
    if (tagPart && node.tagName !== tagPart) return false;
    return classParts.every((cls) => node._classes().has(cls));
  });
}

function walk(node, visit) {
  for (const child of node.children || []) {
    if (child?.nodeType === 1) {
      visit(child);
      walk(child, visit);
    }
  }
}

export function createFakeDocument({ visibilityState = "visible" } = {}) {
  const doc = {
    visibilityState,
    activeElement: null,
    createElement(tagName) {
      const node = {
        nodeType: 1,
        tagName: String(tagName),
        className: "",
        hidden: false,
        disabled: false,
        value: "",
        textContent: "",
        scrollHeight: 100,
        scrollTop: 0,
        clientHeight: 100,
        attributes: {},
        dataset: {},
        style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" },
        children: [],
        listeners: {},
        parent: null,
        _classes() {
          return new Set(String(this.className || "").split(/\s+/u).filter(Boolean));
        },
        get classList() {
          const self = this;
          return {
            add(...names) { const s = self._classes(); names.forEach((n) => s.add(n)); self.className = [...s].join(" "); },
            remove(...names) { const s = self._classes(); names.forEach((n) => s.delete(n)); self.className = [...s].join(" "); },
            contains(name) { return self._classes().has(name); },
            toggle(name, force) {
              const has = self._classes().has(name);
              const want = force === undefined ? !has : Boolean(force);
              if (want) this.add(name); else this.remove(name);
              return want;
            },
          };
        },
        setAttribute(key, value) {
          this.attributes[key] = String(value);
          if (String(key).startsWith("data-")) this.dataset[key.slice(5)] = String(value);
          // เบราว์เซอร์จริง: ตั้ง attribute value บน input ที่เพิ่งสร้าง = ตั้ง .value ด้วย
          // (2026-08-28) ถ้าไม่ผูกให้เหมือนกัน เทสต์จะมองไม่เห็นบั๊กค่าค้างข้ามห้อง
          // ซึ่งเป็นบั๊กที่ทำให้ชื่อจริงของลูกค้าคนหนึ่งไปโผล่ในช่องของอีกคนทั้งระบบ
          if (key === "value") this.value = String(value);
        },
        getAttribute(key) { return this.attributes[key] ?? null; },
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        removeEventListener() {},
        dispatch(type, event = {}) { for (const fn of this.listeners[type] || []) fn(event); },
        append(...kids) { for (const k of kids) { if (k?.nodeType === 1) k.parent = this; this.children.push(k); } },
        // rangePicker ของแผง ROAS ใช้ appendChild ตรง ๆ (ไม่ใช่ append) — ขาดตัวนี้
        // ตัวเดียว แผงทั้งแผงก็เรนเดอร์ไม่ผ่าน (2 ก.ย. 2026)
        appendChild(kid) { this.append(kid); return kid; },
        prepend(...kids) { for (const k of kids) { if (k?.nodeType === 1) k.parent = this; } this.children.unshift(...kids); },
        replaceChildren(...kids) {
          this.children = [];
          this.append(...kids);
        },
        replaceWith(next) {
          const siblings = this.parent?.children;
          if (!siblings) return;
          const at = siblings.indexOf(this);
          if (at >= 0) { siblings[at] = next; if (next?.nodeType === 1) next.parent = this.parent; }
        },
        remove() {
          const siblings = this.parent?.children;
          if (!siblings) return;
          const at = siblings.indexOf(this);
          if (at >= 0) siblings.splice(at, 1);
        },
        focus() { doc.activeElement = this; },
        blur() { if (doc.activeElement === this) doc.activeElement = null; },
        setSelectionRange() {},
        scrollIntoView() {},
        querySelector(selector) {
          let found = null;
          walk(this, (n) => { if (!found && matchesSelector(n, selector)) found = n; });
          return found;
        },
        querySelectorAll(selector) {
          const out = [];
          walk(this, (n) => { if (matchesSelector(n, selector)) out.push(n); });
          return out;
        },
        closest(selector) {
          let cur = this;
          while (cur) { if (matchesSelector(cur, selector)) return cur; cur = cur.parent; }
          return null;
        },
      };
      return node;
    },
    // กราฟบนหน้าภาพรวมสร้าง SVG ผ่าน createElementNS — ใช้โครงเดียวกับ element ปกติ
    createElementNS(_ns, tagName) { return doc.createElement(tagName); },
    createTextNode(value) { return { nodeType: 3, textContent: String(value) }; },
  };
  doc.listeners = {};
  doc.addEventListener = (type, fn) => { (doc.listeners[type] ||= []).push(fn); };
  doc.removeEventListener = () => {};
  doc.dispatch = (type, event = {}) => { for (const fn of doc.listeners[type] || []) fn(event); };
  doc.documentElement = doc.createElement("html");
  doc.body = doc.createElement("body");
  doc.querySelector = (selector) => doc.body.querySelector(selector);
  doc.querySelectorAll = (selector) => doc.body.querySelectorAll(selector);
  doc.getElementById = (id) => doc.body.querySelector(`#${id}`);
  return doc;
}

// ติดตั้ง globals ที่หน้าเว็บใช้ แล้วคืนฟังก์ชันถอนออก
export function installBrowserGlobals(t, { hash = "#/", visibilityState = "visible" } = {}) {
  const doc = createFakeDocument({ visibilityState });
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    location: globalThis.location,
    navigator: globalThis.navigator,
  };
  const fakeWindow = {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    confirm: () => true,
    prompt: () => "",
    addEventListener() {},
    removeEventListener() {},
    scrollTo() {},
    innerWidth: 1440,
  };
  // Node ตั้ง navigator/location เป็น getter-only จึงต้องใช้ defineProperty
  const set = (key, value) => Object.defineProperty(globalThis, key, {
    value, configurable: true, writable: true, enumerable: true,
  });
  const restore = (key, value) => {
    if (value === undefined) { try { delete globalThis[key]; } catch { /* ปล่อยไว้ */ } return; }
    set(key, value);
  };
  set("document", doc);
  set("window", fakeWindow);
  set("location", { hash, search: "", href: "https://console.test/console/", origin: "https://console.test" });
  set("navigator", { clipboard: { writeText: async () => {} }, userAgent: "test" });
  set("getComputedStyle", () => ({ getPropertyValue: () => "", height: "100px", display: "block" }));

  // หน้าเว็บตั้ง timer poll ไว้ ถ้าไม่เก็บกวาด process ของเทสต์จะไม่จบ
  // (เจอจริง: เทสต์ค้างจนหมดเวลา ทั้งที่ทุก assert ผ่าน)
  const timers = new Set();
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  set("setTimeout", (fn, ms, ...rest) => {
    const id = realSetTimeout(fn, ms, ...rest);
    timers.add(id); id.unref?.();
    return id;
  });
  set("setInterval", (fn, ms, ...rest) => {
    const id = realSetInterval(fn, ms, ...rest);
    timers.add(id); id.unref?.();
    return id;
  });
  t.after(() => {
    for (const id of timers) { clearTimeout(id); clearInterval(id); }
    timers.clear();
    set("setTimeout", realSetTimeout);
    set("setInterval", realSetInterval);
  });
  t.after(() => {
    restore("getComputedStyle", undefined);
    restore("document", previous.document);
    restore("window", previous.window);
    restore("location", previous.location);
    restore("navigator", previous.navigator);
  });
  return { doc, window: fakeWindow };
}
