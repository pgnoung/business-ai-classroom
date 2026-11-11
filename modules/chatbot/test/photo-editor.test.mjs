import test from "node:test";
import assert from "node:assert/strict";
import { openPhotoEditor, exportPhotoCanvas, photoStudioCard } from "../public/console/photoEditor.mjs";
import { installPhotoBrowser, flushPhoto, firePhoto } from "./photo-browser.mjs";
const file = () => new File(["synthetic"],"class.jpg",{type:"image/jpeg"});

test("photo editor: original is exact file, defaults unchanged, cancel sends nothing", async t => {
  const ui=installPhotoBrowser(t); const source=file();
  let result=openPhotoEditor(source); await flushPhoto();
  assert.deepEqual([...ui.state.paints[0]], [35,40,45,255,70,65,60,255,230,230,230,255,90,80,70,255]);
  assert.equal(ui.permission().checked, undefined);
  assert.equal(ui.button("ใช้รูปนี้แนบแชท").disabled,true);
  await firePhoto(ui.button("ใช้ต้นฉบับ")); assert.equal(await result,source);
  assert.equal(ui.state.encodes.length,0); assert.equal(ui.state.listenerCount(),0);
  result=openPhotoEditor(source);await flushPhoto();await firePhoto(ui.button("ยกเลิก"));
  assert.equal(await result,null); assert.equal(ui.doc.querySelector("dialog"),null);
});

test("photo editor: requires checkbox then adjusts real pixels and returns separate JPEG", async t => {
  const ui=installPhotoBrowser(t);const source=file();const result=openPhotoEditor(source);await flushPhoto();
  const before=ui.state.paints.at(-1).slice();
  ui.permission().checked=true;await firePhoto(ui.permission(),"change");
  await firePhoto(ui.button("ช่วยภาพมืด"));assert.notDeepEqual(ui.state.paints.at(-1),before);
  await firePhoto(ui.button("ใช้รูปนี้แนบแชท"));const output=await result;
  assert.notEqual(output,source);assert.equal(output.type,"image/jpeg");assert.equal(output.name,"class-chat.jpg");
  assert.ok(output.size<=950000);assert.equal(await source.text(),"synthetic");
});

test("photo editor: revoking checkbox restores original and disables export", async t => {
  const ui=installPhotoBrowser(t);const result=openPhotoEditor(file());await flushPhoto();const original=ui.state.paints.at(-1).slice();
  ui.permission().checked=true;await firePhoto(ui.permission(),"change");await firePhoto(ui.button("ช่วยภาพมืด"));
  ui.permission().checked=false;await firePhoto(ui.permission(),"change");
  assert.deepEqual(ui.state.paints.at(-1),original);assert.equal(ui.button("ใช้รูปนี้แนบแชท").disabled,true);
  await firePhoto(ui.button("ใช้รูปนี้แนบแชท"));assert.equal(ui.state.encodes.length,0);
  await firePhoto(ui.button("ยกเลิก"));assert.equal(await result,null);
});

test("photo editor: navigation cancels; later encode cannot return a stale room image", async t => {
  let deliver;let current=true;
  const ui=installPhotoBrowser(t,{encode:cb=>{deliver=cb;}});
  const result=openPhotoEditor(file(),{isCurrent:()=>current});await flushPhoto();
  ui.permission().checked=true;await firePhoto(ui.permission(),"change");await firePhoto(ui.button("ช่วยภาพมืด"));
  const exporting=firePhoto(ui.button("ใช้รูปนี้แนบแชท"));await flushPhoto();
  current=false;ui.state.dispatchWindow("hashchange");assert.equal(await result,null);
  deliver(new Blob(["image"],{type:"image/jpeg"}));await exporting;
  assert.equal(ui.doc.querySelector("dialog"),null);assert.equal(ui.state.listenerCount(),0);
});

test("photo editor: context check also catches a room change before decode finishes", async t => {
  let decoded;let current=true;
  const ui=installPhotoBrowser(t,{decode:()=>new Promise(resolve=>{decoded=resolve;})});
  const result=openPhotoEditor(file(),{isCurrent:()=>current});await flushPhoto();current=false;decoded();
  assert.equal(await result,null);assert.equal(ui.doc.querySelector("dialog"),null);
});

test("photo editor: context check rejects export even without a navigation event", async t => {
  let deliver;let current=true;const ui=installPhotoBrowser(t,{encode:cb=>{deliver=cb;}});
  const result=openPhotoEditor(file(),{isCurrent:()=>current});await flushPhoto();
  ui.permission().checked=true;await firePhoto(ui.permission(),"change");await firePhoto(ui.button("ช่วยภาพมืด"));
  const exporting=firePhoto(ui.button("ใช้รูปนี้แนบแชท"));await flushPhoto();current=false;
  deliver(new Blob(["image"],{type:"image/jpeg"}));await exporting;assert.equal(await result,null);
});

test("photo editor: unsupported, oversized and corrupt inputs do not open a dialog", async t => {
  const ui=installPhotoBrowser(t);
  await assert.rejects(openPhotoEditor(new File(["x"],"x.svg",{type:"image/svg+xml"})),/JPEG/u);
  await assert.rejects(openPhotoEditor({type:"image/jpeg",size:12000001}),/12 MB/u);
  ui.state.decode=async()=>{throw new Error("decode failed");};
  await assert.rejects(openPhotoEditor(file()),/เปิดรูปนี้ไม่ได้/u);
  assert.equal(ui.doc.querySelector("dialog"),null);
});

test("photo editor: export tries bounded compression and fails instead of oversized upload", async () => {
  const qualities=[];const canvas={toBlob(cb,type,q){assert.equal(type,"image/jpeg");qualities.push(q);cb({size:1000000});}};
  await assert.rejects(exportPhotoCanvas(canvas,"class.jpg"),/ใหญ่เกิน/u);
  assert.deepEqual(qualities,[.9,.8,.68,.52]);
});

test("photo studio: saves a local copy without a catalog API call or customer send", async t => {
  const ui=installPhotoBrowser(t);const notices=[];const downloads=[];
  const create=ui.doc.createElement;
  ui.doc.createElement=tag=>{const node=create(tag);if(tag==="a")node.click=()=>downloads.push({...node.attributes});return node;};
  ui.doc.body.append(photoStudioCard({toast:s=>notices.push(s)}));
  const picker=ui.doc.querySelectorAll("input").find(n=>n.attributes.type==="file");
  const selection=firePhoto(picker,"change",{target:{files:[file()],value:"class.jpg"}});await flushPhoto();
  await firePhoto(ui.button("ใช้ต้นฉบับ"));await selection;
  assert.equal(downloads.length,1);assert.equal(downloads[0].download,"class.jpg");
  assert.match(downloads[0].href,/^data:image\//u);assert.match(notices[0],/ยังไม่ได้เพิ่มเข้าคลัง AI หรือส่งลูกค้า/u);
});

test("photo studio: a delayed decode does not reopen the dialog after leaving Knowledge", async t => {
  let decoded;const ui=installPhotoBrowser(t,{decode:()=>new Promise(resolve=>{decoded=resolve;})});
  ui.doc.body.append(photoStudioCard({toast:()=>{throw new Error("no download expected");}}));
  const picker=ui.doc.querySelectorAll("input").find(n=>n.attributes.type==="file");
  const selection=firePhoto(picker,"change",{target:{files:[file()],value:"class.jpg"}});await flushPhoto();
  location.hash="#/chat";decoded();await selection;assert.equal(ui.doc.querySelector("dialog"),null);
});
