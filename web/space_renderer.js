import * as THREE from './vendor/three.module.js';
import {SPIRAL_PATTERN,patternAngle} from './spiral_pattern.mjs';

export const PALETTE = Object.freeze({background: 0x030916, core: 0xeef7ff, blue: 0x94c6ff,
  amber: 0xffc879, violet: 0x9d9bfb, cyan: 0x69ddf4, green: 0x67e8ac, red: 0xff718b});
export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

export function randomSeed(seed) {return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);}
export function glowTexture(flare = false) {
  const canvas = document.createElement('canvas');canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d'), grad = ctx.createRadialGradient(64,64,0,64,64,64);
  grad.addColorStop(0,'#ffffff');grad.addColorStop(.07,'#ffffffff');
  grad.addColorStop(.22,flare?'#d5e7ff99':'#ffffffbb');grad.addColorStop(1,'#ffffff00');
  ctx.fillStyle=grad;ctx.fillRect(0,0,128,128);
  if(flare){
    ctx.globalCompositeOperation='lighter';
    for(const [x,y,w,h] of [[0,62,128,4],[62,0,4,128]]){
      const g=x?ctx.createLinearGradient(64,0,64,128):ctx.createLinearGradient(0,64,128,64);
      g.addColorStop(0,'#ffffff00');g.addColorStop(.5,'#ffffffcc');g.addColorStop(1,'#ffffff00');
      ctx.fillStyle=g;ctx.fillRect(x,y,w,h);
    }
  }
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;return texture;
}
const glow=glowTexture(), flare=glowTexture(true);
export function sprite(color=PALETTE.core,size=1,burst=false,opacity=1){
  const material=new THREE.SpriteMaterial({map:burst?flare:glow,color,transparent:true,opacity,
    blending:THREE.AdditiveBlending,depthWrite:false});
  const object=new THREE.Sprite(material);object.scale.set(size,size,1);return object;
}
export function filament(points,color=PALETTE.blue,opacity=.34,radius=.014){
  const curve=new THREE.CatmullRomCurve3(points.map(p=>p.isVector3?p:new THREE.Vector3(...p)));
  const geometry=new THREE.TubeGeometry(curve,Math.max(14,Math.min(96,points.length*11)),radius,4,false);
  const material=new THREE.MeshBasicMaterial({color,transparent:true,opacity,
    blending:THREE.AdditiveBlending,depthWrite:false});
  return new THREE.Mesh(geometry,material);
}
export function dustCloud(count=2400,seed=9,shape='spiral',radius=20){
  const random=randomSeed(seed), positions=new Float32Array(count*3), colors=new Float32Array(count*3);
  const sizes=new Float32Array(count), phases=new Float32Array(count), radii=new Float32Array(count),arms=new Float32Array(count),laterals=new Float32Array(count),depths=new Float32Array(count),speeds=new Float32Array(count);
  const cloudColors=[new THREE.Color(0x9ac4f5),new THREE.Color(0xe9f5ff),new THREE.Color(0xa7d0ff),
    new THREE.Color(0xe9f5ff),new THREE.Color(0x8978c9),new THREE.Color(0xf3bd7d)];
  for(let i=0;i<count;i++){
    const j=i*3,spiral=shape==='spiral',arm=spiral?i%SPIRAL_PATTERN.armCount:-1,r=spiral?SPIRAL_PATTERN.minRadius+Math.pow(random(),.78)*radius:random()*radius;
    const lateral=spiral?(random()-.5)*(.07+r*.022):(random()-.5)*.75,depth=(random()-.5)*(spiral?2.4+r*.12:4.2);
    const theta=spiral?arm*Math.PI*2/SPIRAL_PATTERN.armCount+(1/Math.tan(SPIRAL_PATTERN.pitchDegrees*Math.PI/180))*Math.log(r/SPIRAL_PATTERN.minRadius):random()*Math.PI*2;
    positions[j]=Math.cos(theta)*r-Math.sin(theta)*lateral;
    positions[j+1]=(Math.sin(theta)*r+Math.cos(theta)*lateral)*SPIRAL_PATTERN.aspect;
    positions[j+2]=depth;
    radii[i]=r;arms[i]=arm;laterals[i]=lateral;depths[i]=depth;speeds[i]=.016/(1+r/7);
    const base=cloudColors[Math.floor(random()*cloudColors.length)];
    colors[j]=base.r;colors[j+1]=base.g;colors[j+2]=base.b;
    sizes[i]=1+Math.pow(random(),5)*5.5;phases[i]=random()*Math.PI*2;
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
  geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
  geometry.setAttribute('aSize',new THREE.BufferAttribute(sizes,1));
  geometry.setAttribute('aPhase',new THREE.BufferAttribute(phases,1));
  geometry.setAttribute('aRadius',new THREE.BufferAttribute(radii,1));
  geometry.setAttribute('aArm',new THREE.BufferAttribute(arms,1));
  geometry.setAttribute('aLateral',new THREE.BufferAttribute(laterals,1));
  geometry.setAttribute('aDepth',new THREE.BufferAttribute(depths,1));
  geometry.setAttribute('aDriftSpeed',new THREE.BufferAttribute(speeds,1));
  const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,vertexColors:true,
    blending:THREE.AdditiveBlending,uniforms:{uTime:{value:0},uPatternAngle:{value:0},uOpacity:{value:1.08}},
    vertexShader:`attribute float aSize;attribute float aPhase;attribute float aRadius;attribute float aArm;attribute float aLateral;attribute float aDepth;attribute float aDriftSpeed;varying vec3 vColor;varying float vPhase;uniform float uTime;uniform float uPatternAngle;
      void main(){vColor=color;vPhase=aPhase;vec3 p=position;if(aArm>=0.0){float drift=.24*sin(uTime*aDriftSpeed+aPhase);float r=aRadius*exp(drift*.267949);float a=aArm*3.141593+3.732051*log(r/1.2)+uPatternAngle+drift;float x=cos(a)*r-sin(a)*aLateral;float y=(sin(a)*r+cos(a)*aLateral)*.68;p=vec3(x,y,aDepth);}else{p.xy=mat2(cos(uPatternAngle*.16),-sin(uPatternAngle*.16),sin(uPatternAngle*.16),cos(uPatternAngle*.16))*p.xy;}vec4 mv=modelViewMatrix*vec4(p,1.);
      gl_Position=projectionMatrix*mv;gl_PointSize=clamp(aSize*34.0/max(3.0,-mv.z),1.0,9.0);}`,
    fragmentShader:`varying vec3 vColor;varying float vPhase;uniform float uTime;uniform float uOpacity;
      void main(){float d=length(gl_PointCoord-.5)*2.0;float a=pow(max(0.0,1.0-d),2.0);
      float twinkle=.72+.28*sin(uTime*.85+vPhase);
      gl_FragColor=vec4(vColor,a*twinkle*uOpacity);}`});
  return new THREE.Points(geometry,material);
}
export function nebulaCloud(count=18,seed=11,radius=18,opacity=1){
  const random=randomSeed(seed), positions=new Float32Array(count*3), colors=new Float32Array(count*3);
  const sizes=new Float32Array(count),phases=new Float32Array(count);
  const palette=[new THREE.Color(0x164f8c),new THREE.Color(0x492575),new THREE.Color(0x156e83)];
  for(let i=0;i<count;i++){
    const j=i*3,a=random()*Math.PI*2,r=(.15+random()*.85)*radius,c=palette[i%palette.length];
    positions[j]=Math.cos(a)*r;positions[j+1]=Math.sin(a)*r*.7;positions[j+2]=(i%2?1:-1)*(4+random()*7);
    colors[j]=c.r;colors[j+1]=c.g;colors[j+2]=c.b;sizes[i]=110+random()*180;phases[i]=random()*6.28;
  }
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
  geometry.setAttribute('color',new THREE.BufferAttribute(colors,3));
  geometry.setAttribute('aSize',new THREE.BufferAttribute(sizes,1));
  geometry.setAttribute('aPhase',new THREE.BufferAttribute(phases,1));
  const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,vertexColors:true,
    blending:THREE.AdditiveBlending,uniforms:{uTime:{value:0},uPatternAngle:{value:0},uOpacity:{value:opacity}},
    vertexShader:`attribute float aSize;attribute float aPhase;varying vec3 vColor;varying float vPhase;uniform float uPatternAngle;
      void main(){vColor=color;vPhase=aPhase;vec2 q=vec2(position.x,position.y/.68);q=mat2(cos(uPatternAngle),-sin(uPatternAngle),sin(uPatternAngle),cos(uPatternAngle))*q;vec3 p=vec3(q.x,q.y*.68,position.z);vec4 mv=modelViewMatrix*vec4(p,1.);
      gl_Position=projectionMatrix*mv;gl_PointSize=min(330.0,aSize*36.0/max(3.0,-mv.z));}`,
    fragmentShader:`varying vec3 vColor;varying float vPhase;uniform float uTime;uniform float uOpacity;
      void main(){float r=length(gl_PointCoord-.5)*2.0;float alpha=pow(max(0.0,1.0-r),4.5);
      gl_FragColor=vec4(vColor,alpha*(.2+.035*sin(uTime*.16+vPhase))*uOpacity);}`});
  return new THREE.Points(geometry,material);
}
const QUAD_VERTEX='varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.,1.);}';
const forceBloom=typeof location!=='undefined'&&location.search.includes('bloom=force');
// HDR scene -> soft-threshold extract (half res) -> 5-level down/up mip chain -> exponential tone map + sRGB.
function bloomPass(width,height){
  const hdr={depthBuffer:false,type:THREE.HalfFloatType};
  const sceneTarget=new THREE.WebGLRenderTarget(width,height,{depthBuffer:true,type:THREE.HalfFloatType,samples:4});
  const bloomTarget=new THREE.WebGLRenderTarget(width,height,hdr);
  const mips=Array.from({length:5},()=>new THREE.WebGLRenderTarget(1,1,hdr));
  const camera=new THREE.OrthographicCamera(-1,1,1,-1,0,1);
  const extractScene=new THREE.Scene(),scene=new THREE.Scene(),passScene=new THREE.Scene();
  const extractMaterial=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,
    uniforms:{tScene:{value:sceneTarget.texture},threshold:{value:.42},knee:{value:.35}},vertexShader:QUAD_VERTEX,
    fragmentShader:`varying vec2 vUv;uniform sampler2D tScene;uniform float threshold;uniform float knee;
      void main(){vec3 c=texture2D(tScene,vUv).rgb;float l=max(c.r,max(c.g,c.b));float soft=clamp(l-threshold+knee,0.,2.*knee);soft=soft*soft/(4.*knee+1e-4);
      gl_FragColor=vec4(c*max(soft,l-threshold)/max(l,1e-4),1.);}`});
  const downMaterial=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,
    uniforms:{tSource:{value:null},texel:{value:new THREE.Vector2()}},vertexShader:QUAD_VERTEX,
    fragmentShader:`varying vec2 vUv;uniform sampler2D tSource;uniform vec2 texel;
      void main(){vec3 c=texture2D(tSource,vUv).rgb*4.;c+=texture2D(tSource,vUv+texel*vec2(-1.,-1.)).rgb;c+=texture2D(tSource,vUv+texel*vec2(1.,-1.)).rgb;
      c+=texture2D(tSource,vUv+texel*vec2(-1.,1.)).rgb;c+=texture2D(tSource,vUv+texel*vec2(1.,1.)).rgb;gl_FragColor=vec4(c/8.,1.);}`});
  const upMaterial=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,transparent:true,
    blending:THREE.CustomBlending,blendSrc:THREE.OneFactor,blendDst:THREE.OneFactor,
    uniforms:{tSource:{value:null},texel:{value:new THREE.Vector2()},weight:{value:1}},vertexShader:QUAD_VERTEX,
    fragmentShader:`varying vec2 vUv;uniform sampler2D tSource;uniform vec2 texel;uniform float weight;
      void main(){vec3 c=texture2D(tSource,vUv).rgb*4.;
      c+=(texture2D(tSource,vUv+vec2(texel.x,0.)).rgb+texture2D(tSource,vUv-vec2(texel.x,0.)).rgb+texture2D(tSource,vUv+vec2(0.,texel.y)).rgb+texture2D(tSource,vUv-vec2(0.,texel.y)).rgb)*2.;
      c+=texture2D(tSource,vUv+texel).rgb+texture2D(tSource,vUv-texel).rgb+texture2D(tSource,vUv+vec2(texel.x,-texel.y)).rgb+texture2D(tSource,vUv+vec2(-texel.x,texel.y)).rgb;
      gl_FragColor=vec4(c/16.*weight,1.);}`});
  const material=new THREE.ShaderMaterial({depthTest:false,depthWrite:false,
    uniforms:{tScene:{value:sceneTarget.texture},tBloom:{value:bloomTarget.texture},texel:{value:new THREE.Vector2(1/width,1/height)},strength:{value:.62},exposure:{value:1.12}},
    vertexShader:QUAD_VERTEX,
    fragmentShader:`varying vec2 vUv;uniform sampler2D tScene;uniform sampler2D tBloom;uniform float strength;uniform float exposure;
      void main(){vec3 c=texture2D(tScene,vUv).rgb+texture2D(tBloom,vUv).rgb*strength;
      c=1.-exp(-c*exposure);float luma=dot(c,vec3(.2126,.7152,.0722));c=mix(vec3(luma),c,1.08);
      float vignette=1.-smoothstep(.36,.86,length((vUv-.5)*vec2(1.18,1.)));c*=.78+.22*vignette;
      c=mix(c*12.92,1.055*pow(max(c,vec3(0.)),vec3(1./2.4))-.055,step(.0031308,c));
      c+=(fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453)-.5)/255.;gl_FragColor=vec4(c,1.);}`});
  const geometry=new THREE.PlaneGeometry(2,2),extractQuad=new THREE.Mesh(geometry,extractMaterial),quad=new THREE.Mesh(geometry,material),passQuad=new THREE.Mesh(geometry,downMaterial);
  extractScene.add(extractQuad);scene.add(quad);passScene.add(passQuad);
  const pass=(renderer,target,source,materialFor)=>{passQuad.material=materialFor;materialFor.uniforms.tSource.value=source.texture;
    materialFor.uniforms.texel.value.set(1/source.width,1/source.height);renderer.setRenderTarget(target);renderer.render(passScene,camera);};
  function blur(renderer){
    let source=bloomTarget;for(const mip of mips){pass(renderer,mip,source,downMaterial);source=mip;}
    const autoClear=renderer.autoClear;renderer.autoClear=false;
    for(let i=mips.length-1;i>0;i--)pass(renderer,mips[i-1],mips[i],upMaterial);
    pass(renderer,bloomTarget,mips[0],upMaterial);renderer.autoClear=autoClear;
  }
  function setSize(bloomWidth,bloomHeight){let w=bloomWidth,h=bloomHeight;for(const mip of mips){w=Math.max(1,w>>1);h=Math.max(1,h>>1);mip.setSize(w,h);}}
  function dispose(){for(const target of [sceneTarget,bloomTarget,...mips])target.dispose();for(const m of [material,extractMaterial,downMaterial,upMaterial])m.dispose();geometry.dispose();}
  return {sceneTarget,bloomTarget,scene,extractScene,camera,material,extractMaterial,geometry,blur,setSize,dispose,glow:forceBloom};
}
export function createSpace(host,{radius=20,dust=2400,seed=7,shape='spiral'}={}){
  const renderer=new THREE.WebGLRenderer({antialias:false,powerPreference:'high-performance'});
  renderer.setClearColor(PALETTE.background,1);
  host.appendChild(renderer.domElement);
  const scene=new THREE.Scene();scene.background=new THREE.Color(PALETTE.background);
  const camera=new THREE.PerspectiveCamera(42,1,.1,250);
  const nebula=nebulaCloud(18,seed+33,radius,.4),stars=dustCloud(dust,seed,shape,radius);
  const perimeterNebula=nebulaCloud(12,seed+71,radius*1.9,.2);
  const perimeterDust=dustCloud(Math.min(2200,Math.max(900,Math.round(dust*.13))),seed+91,'ambient',radius*2.25);
  perimeterDust.material.uniforms.uOpacity.value=.24;
  scene.add(perimeterNebula,perimeterDust,nebula,stars);
  const bloom=bloomPass(1,1);let slow=0,disposed=false;
  const resize=()=>{
    if(disposed)return;const w=host.clientWidth,h=host.clientHeight;if(!w||!h)return;
    const ratio=Math.min(devicePixelRatio||1,bloom.glow?1.5:1);
    renderer.setPixelRatio(ratio);renderer.setSize(w,h,false);
    camera.aspect=w/h;camera.updateProjectionMatrix();
    const fullWidth=Math.max(1,Math.floor(w*ratio)),fullHeight=Math.max(1,Math.floor(h*ratio)),bloomWidth=Math.max(1,Math.floor(fullWidth*.5)),bloomHeight=Math.max(1,Math.floor(fullHeight*.5));
    bloom.sceneTarget.setSize(fullWidth,fullHeight);bloom.bloomTarget.setSize(bloomWidth,bloomHeight);bloom.setSize(bloomWidth,bloomHeight);
  };
  const observer=new ResizeObserver(resize);observer.observe(host);resize();
  function render(now,delta=16){
    const t=now*.001;stars.material.uniforms.uTime.value=t;nebula.material.uniforms.uTime.value=t;
    perimeterDust.material.uniforms.uTime.value=t;perimeterNebula.material.uniforms.uTime.value=t;
    const phi=reducedMotion.matches?0:patternAngle(t);
    for(const cloud of [stars,nebula,perimeterDust,perimeterNebula])cloud.material.uniforms.uPatternAngle.value=phi;
    renderer.setRenderTarget(bloom.sceneTarget);renderer.render(scene,camera);
    if(bloom.glow){renderer.setRenderTarget(bloom.bloomTarget);renderer.render(bloom.extractScene,bloom.camera);bloom.blur(renderer);}
    bloom.material.uniforms.strength.value=bloom.glow?.55:0;
    renderer.setRenderTarget(null);renderer.render(bloom.scene,bloom.camera);
    slow=delta>30?slow+1:Math.max(0,slow-1);
    if(slow>100&&!forceBloom&&stars.geometry.drawRange.count===Infinity)stars.geometry.setDrawRange(0,Math.ceil(dust*.6));
  }
  function dispose(){if(disposed)return;disposed=true;observer.disconnect();
    for(const o of [stars,nebula,perimeterDust,perimeterNebula]){o.geometry.dispose();o.material.dispose();}
    bloom.dispose();renderer.dispose();renderer.forceContextLoss();renderer.domElement.remove();}
  return {renderer,scene,camera,stars,nebula,perimeterDust,perimeterNebula,render,resize,dispose,get bloom(){return bloom.glow;}};
}
export function disposeObject(object){object.traverse(o=>{o.geometry?.dispose();
  if(Array.isArray(o.material))o.material.forEach(m=>m.dispose());else o.material?.dispose();});}
