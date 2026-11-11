import test from "node:test";
import assert from "node:assert/strict";
import { PHOTO_PRESETS, adjustPhotoPixels, assessPhoto, photoSettings, photoSize } from "../public/console/photoAdjustments.mjs";

test("photo: original is an exact copy; adjustments never alter source or alpha", () => {
  const source = new Uint8ClampedArray([30, 45, 60, 255, 200, 180, 170, 0]);
  const saved = source.slice();
  const original = adjustPhotoPixels(source);
  assert.deepEqual(original, saved); assert.notEqual(original, source);
  for (const settings of Object.values(PHOTO_PRESETS)) {
    const result = adjustPhotoPixels(source, settings);
    assert.deepEqual(source, saved);
    assert.equal(result.length, source.length);
    assert.equal(result[3], 255); assert.equal(result[7], 0);
  }
});

test("photo: bounded controls and finite results even with invalid settings", () => {
  assert.deepEqual(photoSettings({ brightness: Infinity, contrast: -999, saturation: "999", warmth: "bad" }),
    { brightness: 0, contrast: -15, saturation: 20, warmth: 0 });
  for (let gray = 0; gray <= 255; gray++) {
    const result = adjustPhotoPixels([gray, gray, gray, 255], { brightness: 999, contrast: 999, saturation: 999, warmth: 999 });
    assert.ok([...result].every(x => Number.isFinite(x) && x >= 0 && x <= 255));
  }
});

test("photo: bright preset lifts a dark photo without changing geometry", () => {
  const dark = new Uint8ClampedArray([40, 40, 40, 255, 60, 55, 45, 255]);
  const bright = adjustPhotoPixels(dark, PHOTO_PRESETS.bright);
  assert.ok(assessPhoto(bright).mean > assessPhoto(dark).mean);
  assert.deepEqual([...adjustPhotoPixels([255, 255, 255, 255], { brightness: 1 })], [255, 255, 255, 255]);
  assert.equal(bright.length, dark.length);
});

test("photo: recommendation is optional and uses opaque luminance, not a quality promise", () => {
  assert.equal(assessPhoto([20,20,20,255]).suggested, "bright");
  assert.equal(assessPhoto([100,100,100,255]).suggested, "natural");
  assert.equal(assessPhoto([220,220,220,255]).suggested, "original");
  assert.equal(assessPhoto([0,0,0,0]).suggested, "original");
  assert.equal(assessPhoto([]).suggested, "original");
});

test("photo: mobile export preserves aspect ratio, caps resolution, never upscales", () => {
  assert.deepEqual(photoSize(4000,3000), { width:1600,height:1200 });
  assert.deepEqual(photoSize(3000,4000), { width:1200,height:1600 });
  assert.deepEqual(photoSize(600,400), { width:600,height:400 });
  for (const [w,h] of [[0,2],[NaN,2],[Infinity,1],[9000,9000]]) assert.throws(()=>photoSize(w,h));
});
