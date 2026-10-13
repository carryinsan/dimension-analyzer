// Arix Dimension Auto — dependency-free visual-region analysis endpoint.
// The endpoint receives a downsampled RGB raster from index.html. No external service or model is used.
export const config = { runtime: 'edge' };
const MAX_SIDE = 420;
const MAX_PIXELS = MAX_SIDE * MAX_SIDE;
const MAX_BODY = 1_300_000;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  }});
}
const clamp=(v,a,b)=>Math.min(b,Math.max(a,v));
const rgbDist=(r,g,b,c)=>Math.sqrt((r-c[0])**2+(g-c[1])**2+(b-c[2])**2);
function decodeRGB(b64, expected) {
  if (typeof b64 !== 'string' || b64.length > MAX_BODY) throw new Error('Image raster is missing or too large.');
  let raw; try { raw=atob(b64); } catch { throw new Error('Raster is not valid base64.'); }
  if (raw.length !== expected*3) throw new Error('Raster byte count does not match its dimensions.');
  const out=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++) out[i]=raw.charCodeAt(i);
  return out;
}
function borderPositions(w,h) {
  const out=[]; const stepx=Math.max(1,Math.floor(w/140)),stepy=Math.max(1,Math.floor(h/140));
  for(let x=0;x<w;x+=stepx){out.push(x);if(h>1)out.push((h-1)*w+x);}
  for(let y=stepy;y<h-1;y+=stepy){out.push(y*w);if(w>1)out.push(y*w+w-1);}
  return out;
}
function makeBackgroundModel(pixels,w,h,border) {
  const med=channel=>{const vals=border.map(p=>pixels[p*3+channel]).sort((a,b)=>a-b);return vals[Math.floor(vals.length/2)]||0;};
  const centers=[[med(0),med(1),med(2)]];
  // Farthest-point initialization prevents all five seeds landing in one colour cluster.
  for(let k=1;k<5;k++){
    let best=[128,128,128],bestD=-1;
    const hop=Math.max(1,Math.floor(border.length/5000));
    for(let q=0;q<border.length;q+=hop){const p=border[q],c=[pixels[p*3],pixels[p*3+1],pixels[p*3+2]];let d=Infinity;for(const z of centers)d=Math.min(d,rgbDist(c[0],c[1],c[2],z));if(d>bestD){bestD=d;best=c;}}
    centers.push(best);
  }
  const assign=()=>{const counts=centers.map(()=>[0,0,0,0]);for(const p of border){const r=pixels[p*3],g=pixels[p*3+1],b=pixels[p*3+2];let bi=0,bd=Infinity;for(let k=0;k<centers.length;k++){const d=rgbDist(r,g,b,centers[k]);if(d<bd){bd=d;bi=k;}}const c=counts[bi];c[0]+=r;c[1]+=g;c[2]+=b;c[3]++;}for(let k=0;k<centers.length;k++)if(counts[k][3])centers[k]=counts[k].slice(0,3).map(v=>v/counts[k][3]);};
  for(let i=0;i<5;i++)assign();
  const samples=centers.map(()=>[]);
  for(const p of border){const r=pixels[p*3],g=pixels[p*3+1],b=pixels[p*3+2];let bi=0,bd=Infinity;for(let k=0;k<centers.length;k++){const d=rgbDist(r,g,b,centers[k]);if(d<bd){bd=d;bi=k;}}samples[bi].push(bd);}
  const thresholds=samples.map(s=>{if(!s.length)return 38;s.sort((a,b)=>a-b);const med=s[Math.floor(s.length*.5)]||0;return clamp(med*2.3+24,30,70);});
  const spread=thresholds.reduce((a,b)=>a+b,0)/thresholds.length;
  return {centers,thresholds,spread};
}
function closeMask(mask,w,h) {
  const n=w*h,dilated=new Uint8Array(n),out=new Uint8Array(n);
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){let v=0;for(let dy=-1;dy<=1&&!v;dy++)for(let dx=-1;dx<=1;dx++){if(mask[(y+dy)*w+x+dx]){v=1;break;}}dilated[y*w+x]=v;}
  for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){let v=1;for(let dy=-1;dy<=1&&v;dy++)for(let dx=-1;dx<=1;dx++){if(!dilated[(y+dy)*w+x+dx]){v=0;break;}}out[y*w+x]=v;}
  return out;
}
function components(mask,w,h,maxObjects) {
  const n=w*h,seen=new Uint8Array(n),stack=new Int32Array(n),regions=[];const minArea=Math.max(24,Math.floor(n*.00032));
  for(let p=0;p<n;p++){
    if(!mask[p]||seen[p])continue;
    let top=0,area=0,minX=w,minY=h,maxX=0,maxY=0,edge=0;stack[top++]=p;seen[p]=1;
    while(top){const q=stack[--top],x=q%w,y=(q/w)|0;area++;if(x<minX)minX=x;if(x>maxX)maxX=x;if(y<minY)minY=y;if(y>maxY)maxY=y;if(x<=1||y<=1||x>=w-2||y>=h-2)edge++;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!dx&&!dy)continue;const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=w||yy>=h)continue;const z=yy*w+xx;if(mask[z]&&!seen[z]){seen[z]=1;stack[top++]=z;}}
    }
    const bw=maxX-minX+1,bh=maxY-minY+1,fill=area/(bw*bh),frame=area/n,aspect=Math.max(bw/bh,bh/bw);
    if(area<minArea||bw<8||bh<8||bw>w*.94||bh>h*.94||edge>Math.max(3,area*.008)||fill<.035||aspect>28)continue;
    // The quality label describes visual separation only; it is not a claim of measurement accuracy.
    const quality=fill>.48&&frame<.35?'high':fill>.12&&frame<.55?'medium':'low';
    regions.push({x:minX,y:minY,w:bw,h:bh,area,quality,label:'Foreground candidate'});
  }
  regions.sort((a,b)=>b.area-a.area);
  // Suppress near-duplicate regions caused by antialiased fragments or nested contours.
  const picked=[];
  for(const r of regions){const duplicate=picked.some(q=>{const ix=Math.max(0,Math.min(r.x+r.w,q.x+q.w)-Math.max(r.x,q.x));const iy=Math.max(0,Math.min(r.y+r.h,q.y+q.h)-Math.max(r.y,q.y));const inter=ix*iy;return inter/Math.max(1,Math.min(r.w*r.h,q.w*q.h))>.78;});if(!duplicate)picked.push(r);if(picked.length>=maxObjects)break;}
  return picked;
}
function analyze(payload) {
  const w=payload.width,h=payload.height;
  if(!Number.isInteger(w)||!Number.isInteger(h)||w<24||h<24||w>MAX_SIDE||h>MAX_SIDE||w*h>MAX_PIXELS)throw new Error(`Raster dimensions must be between 24 and ${MAX_SIDE} pixels per side.`);
  const pixels=decodeRGB(payload.pixels,w*h),border=borderPositions(w,h),model=makeBackgroundModel(pixels,w,h,border);
  const mask=new Uint8Array(w*h);
  for(let p=0;p<w*h;p++){const d=Math.min(...model.centers.map(c=>rgbDist(pixels[p*3],pixels[p*3+1],pixels[p*3+2],c)));let nearest=0,bd=Infinity;for(let k=0;k<model.centers.length;k++){const dd=rgbDist(pixels[p*3],pixels[p*3+1],pixels[p*3+2],model.centers[k]);if(dd<bd){bd=dd;nearest=k;}}mask[p]=d>model.thresholds[nearest]?1:0;}
  const cleaned=closeMask(mask,w,h),maxObjects=clamp(Number.isInteger(payload.maxObjects)?payload.maxObjects:8,1,12);
  let regions=components(cleaned,w,h,maxObjects);
  let warnings=[];
  if(!regions.length){
    // Explicitly labelled fallback, so the app returns an annotated image rather than a fabricated object detection.
    regions=[{x:Math.round(w*.04),y:Math.round(h*.04),w:Math.round(w*.92),h:Math.round(h*.92),area:w*h,quality:'low',label:'Whole scene fallback'}];
    warnings.push('No confidently isolated foreground region was found; the whole-scene rectangle is a fallback, not an object detection.');
  }
  const nonzero=mask.reduce((a,b)=>a+b,0),foregroundRatio=nonzero/(w*h);
  if(foregroundRatio>.72)warnings.push('Background and foreground colours overlap heavily; regions may be merged or incomplete.');
  warnings.push('Dimensions are 2D image-space spans in pixels. A physical scale and hidden depth cannot be inferred from a single uncalibrated photo.');
  return {ok:true,width:w,height:h,regions,method:'border-colour saliency + morphological closing + connected components',externalServices:false,foregroundRatio:Number(foregroundRatio.toFixed(3)),warnings};
}
export default async function handler(request) {
  if(request.method==='GET')return json({ok:true,name:'Arix Dimension Auto',version:'2.0.0',externalServices:false,capabilities:['automatic visual-region proposals','image-space width and height','no external API']});
  if(request.method!=='POST')return json({ok:false,error:'Method not allowed. Use GET or POST.'},405);
  let payload;
  try{const raw=await request.text();if(raw.length>MAX_BODY+15000)return json({ok:false,error:'Request is too large. Use an image under the 20 MB upload limit.'},413);payload=JSON.parse(raw);}catch{return json({ok:false,error:'Expected a valid JSON request.'},400);}
  if(!payload||typeof payload!=='object'||Array.isArray(payload))return json({ok:false,error:'Expected a JSON object.'},400);
  if(payload.action!=='analyze')return json({ok:false,error:'Supported action: analyze.'},400);
  try{return json(analyze(payload));}catch(e){return json({ok:false,error:e&&e.message?e.message:'The image could not be analysed.'},422);}
}
