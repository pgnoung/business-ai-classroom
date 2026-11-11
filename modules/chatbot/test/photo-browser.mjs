// Synthetic pixels and DOM only. No customer files, image services or network calls.
import { installBrowserGlobals } from "./console-dom.mjs";
export const flushPhoto = async () => { for(let i=0;i<30;i++) await Promise.resolve(); };
export const photoText = node => String(node.textContent || "") + (node.children || []).map(photoText).join("");
export async function firePhoto(node, event = "click", data = {}) {
  if (!node) throw new Error("photo test target not found");
  for(const callback of node.listeners[event] || []) await callback(data);
}
export function installPhotoBrowser(t, options = {}) {
  const {doc,window} = installBrowserGlobals(t);
  const state = { uploads:[], paints:[], encodes:[], decode: options.decode || (async()=>{}), encode: options.encode || (callback=>callback(new Blob(["synthetic-jpeg"],{type:"image/jpeg"}))) };
  const create = doc.createElement.bind(doc);
  doc.createElement = tag => {
    const node = create(tag);
    const attr = node.setAttribute.bind(node);
    node.setAttribute = (key,value) => { attr(key,value); if(["disabled","hidden","checked"].includes(key)) node[key]=true; };
    Object.defineProperty(node,"nextSibling",{get:()=>node.parent?.children[node.parent.children.indexOf(node)+1]});
    Object.defineProperty(node,"isConnected",{get:()=>!!node.parent});
    node.showModal = () => {node.open=true;}; node.close = () => {node.open=false;};
    node.click = () => { for(const cb of node.listeners.click || []) cb({}); };
    if(tag==="canvas") {
      const pixels = new Uint8ClampedArray([35,40,45,255,70,65,60,255,230,230,230,255,90,80,70,255]);
      node.getContext = () => ({ fillRect(){},drawImage(){},getImageData:()=>({data:pixels.slice()}),
        createImageData:()=>({data:new Uint8ClampedArray(pixels.length)}),
        putImageData:data=>{node.pixels=data.data.slice();state.paints.push(node.pixels);} });
      node.toBlob = (callback,type,quality) => {state.encodes.push({type,quality});state.encode(callback);};
    }
    return node;
  };
  const listeners = new Map();
  window.addEventListener=(name,fn)=>{if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);};
  window.removeEventListener=(name,fn)=>listeners.get(name)?.delete(fn);
  state.dispatchWindow = name => {for(const fn of listeners.get(name)||[])fn();};
  state.listenerCount = () => [...listeners.values()].reduce((sum,s)=>sum+s.size,0);
  const replacements={
    Image:class {naturalWidth=2;naturalHeight=2;decode(){return state.decode();}},
    FileReader:class {readAsDataURL(){this.result="data:image/jpeg;base64,AA==";queueMicrotask(()=>this.onload());}},
    requestAnimationFrame:fn=>{queueMicrotask(fn);return 1;},cancelAnimationFrame:()=>{},
    fetch:()=>{throw new Error("photo tests forbid network");},
  };
  for(const [key,value] of Object.entries(replacements)) {
    const descriptor=Object.getOwnPropertyDescriptor(globalThis,key);
    Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
    t.after(()=>{if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});
  }
  return {doc,window,state,button:label=>doc.querySelectorAll("button").find(n=>photoText(n)===label),
    permission:()=>doc.querySelectorAll("input").find(n=>n.attributes.type==="checkbox")};
}
