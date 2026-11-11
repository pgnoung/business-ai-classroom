// scrollKeeper.mjs — เก็บ/คืนตำแหน่ง scroll ของ DOM ที่ถูกสร้างใหม่จาก poll/render
//
// กติกา:
// - scope ต้องตรงหน้า/ห้องเดิมเท่านั้น
// - เก็บค่า 0 ด้วย เพื่อไม่ให้ค่ารอบเก่าดึงผู้ใช้กลับไปตำแหน่งเดิม
// - data-scroll-key ใช้แยก container ชนิดเดียวกันเมื่อมีมากกว่าหนึ่งตัว

export const SCROLL_KEEP = [
  { selector: ".page-scroll", scope: (hash) => (hash.split("/")[1] || "overview").split("?")[0] },
  { selector: ".ctx-scroll", scope: (hash) => (hash.startsWith("#/c/") ? hash : "") },
  { selector: ".convo-list", scope: (hash) => (hash.startsWith("#/c") || hash.startsWith("#/chat") ? "chat" : "") },
];

function nodesFor(root, selector) {
  if (typeof root?.querySelectorAll === "function") return [...root.querySelectorAll(selector)];
  const one = root?.querySelector?.(selector);
  return one ? [one] : [];
}

function elementKey(definition, node, index) {
  const explicit = node?.getAttribute?.("data-scroll-key") || node?.dataset?.scrollKey || "";
  return `${definition.selector}:${explicit || index}`;
}

export function captureScroll(root, hash, kept, definitions = SCROLL_KEEP) {
  for (const definition of definitions) {
    const scope = definition.scope(hash);
    const nodes = nodesFor(root, definition.selector);
    nodes.forEach((node, index) => {
      kept.set(elementKey(definition, node, index), {
        scope,
        top: Math.max(0, Number(node.scrollTop) || 0),
      });
    });
  }
}

export function restoreScroll(root, hash, kept, definitions = SCROLL_KEEP) {
  for (const definition of definitions) {
    const scope = definition.scope(hash);
    const nodes = nodesFor(root, definition.selector);
    nodes.forEach((node, index) => {
      const saved = kept.get(elementKey(definition, node, index));
      if (!saved) return;
      if (!scope || saved.scope !== scope) {
        kept.delete(elementKey(definition, node, index));
        return;
      }
      node.scrollTop = saved.top;
    });
  }
}
