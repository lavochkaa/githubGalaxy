import * as THREE from './vendor/three.module.js';
import {randomSeed} from './space_renderer.js';
import {GALAXY_ARMS,armSigma} from './galaxy_arm_layout.mjs';

// GPU twin of galaxyArmPointInto: the same arm, drift and pattern angle, so CPU picking stays on the stars.
const ARM_GLSL=`uniform float uTime;uniform float uPattern;uniform float uViewport;uniform float uOpacity;uniform float uArmCount;uniform sampler2D uArmState;
attribute vec4 aArm;attribute vec4 aOrbit;
float armState(){return texture2D(uArmState,vec2((aArm.x+.5)/uArmCount,.5)).r*2.;}
float armDrift(float radius,float phase){if(phase<-50.)return 0.;return clamp(.24*sin(uTime*(.05/(1.+radius/7.))+phase),-.35,.35);}
vec3 armPointAt(float radius,float lateral){float drift=armDrift(radius,aOrbit.w);float r=radius*exp(drift/aArm.z);
  float th=aArm.x*6.2831853/max(1.,aArm.y)+aArm.z*log(r/aArm.w)+uPattern+drift;
  return vec3(cos(th)*r-sin(th)*lateral,(sin(th)*r+cos(th)*lateral)*${GALAXY_ARMS.aspect.toFixed(3)},aOrbit.z);}
// Grand-design density wave: two broad, more open spiral bands brighten the repository arms they cross.
float grand(float radius){float th=aArm.x*6.2831853/max(1.,aArm.y)+aArm.z*log(radius/aArm.w)-1.55*log(radius/aArm.w);
  return pow(.5+.5*cos(2.*th),2.6);}
float pixels(vec4 mv){return projectionMatrix[1][1]*uViewport*.5/max(.5,-mv.z);}`;
const QUIET=-99;
const hashOf=value=>{let n=2166136261;for(const char of String(value))n=Math.imul(n^char.charCodeAt(0),16777619);return n>>>0;};
const gauss=random=>(random()+random()+random()+random()-2)/.58;

const COLORS={core:new THREE.Color(0xfff1dc),inner:new THREE.Color(0xffd7a3),mid:new THREE.Color(0xdde8ff),outer:new THREE.Color(0x86b4ff),
  giant:new THREE.Color(0xb9d4ff),ember:new THREE.Color(0xffb06a),gas:new THREE.Color(0x3c6fe0),gasViolet:new THREE.Color(0x7a5ee6),
  gasWarm:new THREE.Color(0xd08a55),hii:new THREE.Color(0xff86b8),lane:new THREE.Color(0x010309)};

function radialTone(target,u,tint){
  const color=u<.32?target.copy(COLORS.inner).lerp(COLORS.mid,u/.32):target.copy(COLORS.mid).lerp(COLORS.outer,Math.min(1,(u-.32)/.6));
  return color.lerp(tint,.18+.5*Math.min(1,u/.5));
}
function layer(count,extra){
  const fields={aArm:4,aOrbit:4,aColor:3,aSize:1,aBright:1,aSeed:1,...extra},data={};
  for(const [name,size] of Object.entries(fields))data[name]=new Float32Array(count*size);
  return {count,fields,data,index:0};
}
function push(target,values){
  const i=target.index++;for(const [name,value] of Object.entries(values)){const size=target.fields[name];
    if(size===1)target.data[name][i]=value;else for(let k=0;k<size;k++)target.data[name][i*size+k]=value[k];}
}
function geometryOf(target){
  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(target.count*3),3));
  for(const [name,size] of Object.entries(target.fields))geometry.setAttribute(name,new THREE.BufferAttribute(target.data[name],size));
  geometry.boundingSphere=new THREE.Sphere(new THREE.Vector3(),GALAXY_ARMS.outerRadius*1.4);return geometry;
}
function material(uniforms,vertex,fragment,blending=THREE.AdditiveBlending){
  return new THREE.ShaderMaterial({uniforms,transparent:true,depthWrite:false,depthTest:false,blending,
    vertexShader:ARM_GLSL+vertex,fragmentShader:fragment});
}

const STAR_VERTEX=`attribute vec3 aColor;attribute float aSize;attribute float aBright;attribute float aSeed;varying vec3 vColor;varying float vAlpha;
void main(){vec3 p=armPointAt(aOrbit.x,aOrbit.y);vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;
  float state=armState(),size=aSize*pixels(mv),twinkle=.8+.2*sin(uTime*(1.1+aSeed*2.3)+aSeed*61.);
  float focus=max(state-1.,0.),wave=mix(.3+1.15*grand(aOrbit.x),1.,focus);float alpha=aBright*twinkle*wave*uOpacity*min(state,1.)*(1.+focus*1.8);
  if(size<1.6){alpha*=size/1.6;size=1.6;}gl_PointSize=min(size,48.);vColor=aColor;vAlpha=alpha;}`;
const STAR_FRAGMENT=`varying vec3 vColor;varying float vAlpha;
void main(){float d=length(gl_PointCoord-.5)*2.;float glow=exp(-d*d*7.)+exp(-d*4.)*.18;glow*=1.-smoothstep(.8,1.,d);
  gl_FragColor=vec4(vColor*glow*vAlpha,1.);}`;

// Commits: real stars with a hot core, halo and four-point diffraction glint for the newest ones.
const COMMIT_VERTEX=`attribute vec3 aColor;attribute float aSize;attribute float aBright;attribute float aSeed;attribute float aGlint;varying vec3 vColor;varying float vAlpha;varying float vGlint;
void main(){vec3 p=armPointAt(aOrbit.x,aOrbit.y);vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;
  float state=armState(),pulse=.86+.14*sin(uTime*(.9+aSeed)+aSeed*40.);
  vAlpha=aBright*pulse*uOpacity*min(state,1.)*(1.+max(state-1.,0.)*.7);vGlint=aGlint*min(state,1.);
  gl_PointSize=clamp(aSize*pixels(mv)*(aGlint>0.?7.:3.2),3.,160.);vColor=aColor;}`;
const COMMIT_FRAGMENT=`varying vec3 vColor;varying float vAlpha;varying float vGlint;
void main(){vec2 uv=(gl_PointCoord-.5)*2.;float scale=vGlint>0.?7./3.2:1.;vec2 q=uv*scale;float d=length(q);
  float core=exp(-d*d*16.)*1.6,halo=exp(-d*2.6)*.32;
  float spikes=0.;if(vGlint>0.){vec2 a=abs(uv);spikes=(exp(-a.y*90.)*pow(max(0.,1.-a.x),3.)+exp(-a.x*90.)*pow(max(0.,1.-a.y),3.))*.9*vGlint;
    vec2 r=abs(mat2(.7071,-.7071,.7071,.7071)*uv);spikes+=(exp(-r.y*140.)*pow(max(0.,1.-r.x*1.6),4.)+exp(-r.x*140.)*pow(max(0.,1.-r.y*1.6),4.))*.25*vGlint;}
  float edge=1.-smoothstep(.85,1.,length(uv));
  gl_FragColor=vec4((vColor*(core+halo)+mix(vColor,vec3(1.),.5)*spikes)*vAlpha*edge,1.);}`;

// Gas and dust lanes are elongated along the arm tangent so the arms read as streaming filaments.
const CLOUD_VERTEX=`uniform float uDark;attribute vec3 aColor;attribute float aSize;attribute float aBright;attribute float aSeed;varying vec3 vColor;varying float vAlpha;varying vec2 vAxis;varying float vSeed;
void main(){vec3 p=armPointAt(aOrbit.x,aOrbit.y);vec3 ahead=armPointAt(aOrbit.x*1.03+.02,aOrbit.y);
  vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;vec4 next=projectionMatrix*modelViewMatrix*vec4(ahead,1.);
  vec2 axis=next.xy/next.w-gl_Position.xy/gl_Position.w;axis.y*=-1.;vAxis=length(axis)>1e-6?normalize(axis):vec2(1.,0.);
  float state=armState(),focus=max(state-1.,0.);vAlpha=aBright*uOpacity*min(state,1.)*(1.+focus*.9)*(uDark>0.?1.:mix(.22+1.35*grand(aOrbit.x),1.2,focus));
  gl_PointSize=clamp(aSize*pixels(mv),2.,360.);vColor=aColor;vSeed=aSeed;}`;
const CLOUD_FRAGMENT=`varying vec3 vColor;varying float vAlpha;varying vec2 vAxis;varying float vSeed;uniform float uStretch;uniform float uDark;
void main(){vec2 uv=(gl_PointCoord-.5)*2.;vec2 q=vec2(dot(uv,vAxis),dot(uv,vec2(-vAxis.y,vAxis.x)));
  q.y*=uStretch;float d=dot(q,q);float wisp=.75+.25*sin(q.x*5.+vSeed*30.)*sin(q.y*3.+vSeed*17.);
  float a=exp(-d*3.4)*wisp*(1.-smoothstep(.7,1.,length(uv)));
  if(uDark>0.)gl_FragColor=vec4(vColor,a*vAlpha);else gl_FragColor=vec4(vColor*a*vAlpha,1.);}`;

const LINE_VERTEX=`attribute float aBright;varying float vAlpha;attribute vec3 aColor;varying vec3 vTint;
void main(){vec3 p=armPointAt(aOrbit.x,aOrbit.y);gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);
  float state=armState();float fade=1.-smoothstep(.15,1.,aOrbit.x/${GALAXY_ARMS.outerRadius.toFixed(1)});vTint=aColor;vAlpha=uOpacity*min(state,1.)*(aBright+max(state-1.,0.)*.55*(.25+.75*fade));}`;
const LINE_FRAGMENT=`varying float vAlpha;varying vec3 vTint;uniform vec3 uColor;void main(){gl_FragColor=vec4(mix(uColor,vTint,.6)*vAlpha,1.);}`;

// The bulge is not tied to an arm: a warm, flattened ellipsoid that turns rigidly with the pattern.
const BULGE_VERTEX=`attribute vec3 aColor;attribute float aSize;attribute float aBright;attribute float aSeed;varying vec3 vColor;varying float vAlpha;
void main(){float c=cos(uPattern),s=sin(uPattern);vec2 q=vec2(position.x,position.y/${GALAXY_ARMS.aspect.toFixed(3)});q=mat2(c,s,-s,c)*q;
  vec4 mv=modelViewMatrix*vec4(q.x,q.y*${GALAXY_ARMS.aspect.toFixed(3)},position.z,1.);gl_Position=projectionMatrix*mv;
  float size=aSize*pixels(mv),alpha=aBright*uOpacity*(.85+.15*sin(uTime*(1.+aSeed)+aSeed*50.));
  if(size<1.6){alpha*=size/1.6;size=1.6;}gl_PointSize=min(size,64.);vColor=aColor;vAlpha=alpha;}`;

export function createArmGalaxy(items){
  const count=Math.max(1,items.length),R=GALAXY_ARMS.outerRadius;
  const stateData=new Uint8Array(count*4).fill(127),armState=new THREE.DataTexture(stateData,count,1,THREE.RGBAFormat);
  armState.magFilter=armState.minFilter=THREE.NearestFilter;armState.needsUpdate=true;
  const uniforms={uTime:{value:0},uPattern:{value:0},uViewport:{value:900},uOpacity:{value:1},uArmCount:{value:count},uArmState:{value:armState}};
  const shared=extra=>({...uniforms,uOpacity:{value:1},...extra});
  const tint=new THREE.Color(),tone=new THREE.Color();
  const budgets=items.map(item=>Math.round(Math.min(1500,620+58*Math.sqrt(Math.max(0,item.repo.commits||0)))));
  const stars=layer(budgets.reduce((a,b)=>a+b,0)),gas=layer(items.length*110),lanes=layer(items.length*64),hii=layer(items.length*4);
  const commits=layer(items.reduce((sum,item)=>sum+item.commits.length,0),{aGlint:1});
  const lineSteps=56,lines=layer(items.length*lineSteps*2);
  items.forEach((item,arm)=>{
    const random=randomSeed(hashOf(item.repo.fullName||item.repo.name)),inner=item.innerRadius,cot=1/Math.tan(item.pitchDegrees*Math.PI/180);
    const armRow=[arm,count,cot,GALAXY_ARMS.minRadius],sigma=radius=>armSigma(item,radius),span=R-inner;
    tint.set(item.languageColor??0x9cc6ff);
    for(let i=0;i<budgets[arm];i++){
      const u=Math.pow(random(),.9),radius=inner+span*u,wide=random()<.14,lateral=gauss(random)*sigma(radius)*(wide?1.35:.6);
      const giant=random()<.035,ember=!giant&&random()<.02;
      radialTone(tone,u,tint);if(giant)tone.copy(COLORS.giant);if(ember)tone.copy(COLORS.ember);
      const bright=(giant||ember?1.5:.5+random()*.5)*(1.08-.5*u)*(wide?.6:1);
      push(stars,{aArm:armRow,aOrbit:[radius,lateral,gauss(random)*(.12+radius*.03)*(wide?1.8:1),random()*6.283],aColor:[tone.r,tone.g,tone.b],
        aSize:giant||ember?.11+random()*.07:.035+Math.pow(random(),3)*.06,aBright:bright,aSeed:random()});
    }
    for(let i=0;i<110;i++){
      const u=.04+.94*random(),radius=inner+span*u,violet=random()<.3,warm=u<.22&&random()<.6;
      tone.copy(warm?COLORS.gasWarm:violet?COLORS.gasViolet:COLORS.gas).lerp(tint,.3);
      push(gas,{aArm:armRow,aOrbit:[radius,gauss(random)*sigma(radius)*.45,gauss(random)*(.2+radius*.018),random()*6.283],aColor:[tone.r,tone.g,tone.b],
        aSize:(.8+random()*1.0)*(.55+u*.7),aBright:(.034+random()*.03)*(1.2-u*.5),aSeed:random()});
    }
    // Dark dust lanes sit halfway to the next arm, so every repository reads as its own band.
    for(let i=0;i<64;i++){
      const u=.06+.92*random(),radius=inner+span*u,gap=Math.PI*radius/count,perpendicular=gap*2*Math.sin(item.pitchDegrees*Math.PI/180);
      push(lanes,{aArm:armRow,aOrbit:[radius,gap*(1+gauss(random)*.06),gauss(random)*(.08+radius*.012),random()*6.283],aColor:[COLORS.lane.r,COLORS.lane.g,COLORS.lane.b],
        aSize:Math.max(.35,perpendicular*1.1)*(.9+random()*.4),aBright:.42+random()*.2,aSeed:random()});
    }
    const knots=1+Math.min(3,Math.round(Math.sqrt(item.commits.length)/2));
    for(let i=0;i<knots;i++){
      const u=.35+.6*random(),radius=inner+span*u;
      push(hii,{aArm:armRow,aOrbit:[radius,gauss(random)*sigma(radius)*.4,gauss(random)*.1,random()*6.283],aColor:[COLORS.hii.r,COLORS.hii.g,COLORS.hii.b],
        aSize:.09+random()*.12,aBright:.35+random()*.25,aSeed:random()});
    }
    for(const entry of item.commits){
      const delta=(entry.commit.additions||0)+(entry.commit.deletions||0),merge=entry.commit.parents?.length>1;
      radialTone(tone,(entry.radius-inner)/span,tint).lerp(COLORS.core,.28);
      push(commits,{aArm:armRow,aOrbit:[entry.radius,entry.lateral,entry.depth,entry.phase],aColor:[tone.r,tone.g,tone.b],
        aSize:.06+Math.min(.06,Math.log1p(delta)*.009)+(merge?.015:0),aBright:entry.commitIndex===0?2.2:1.45+(merge?.3:0),aSeed:random(),aGlint:entry.commitIndex===0?1:0});
    }
    for(let step=0;step<lineSteps;step++)for(const s of [step,step+1]){
      const u=s/lineSteps;push(lines,{aArm:armRow,aOrbit:[inner+span*u,0,0,QUIET],aColor:[tint.r,tint.g,tint.b],aSize:0,aBright:.006*Math.pow(1-u,1.2),aSeed:0});
    }
  });
  const bulge=layer(10400),bulgeRandom=randomSeed(9157),positions=bulge.data.position=new Float32Array(bulge.count*3);
  bulge.fields={position:3,...bulge.fields};
  for(let i=0;i<bulge.count;i++){
    const halo=i>=7400,r=halo?3+Math.pow(bulgeRandom(),1.6)*14:Math.abs(gauss(bulgeRandom))*1.5+Math.pow(bulgeRandom(),3)*2.6,a=bulgeRandom()*Math.PI*2,b=Math.acos(2*bulgeRandom()-1);
    positions[i*3]=Math.sin(b)*Math.cos(a)*r;positions[i*3+1]=Math.sin(b)*Math.sin(a)*r*GALAXY_ARMS.aspect;positions[i*3+2]=Math.cos(b)*r*(halo?.62:.82);
    tone.copy(COLORS.core).lerp(COLORS.inner,Math.min(1,r/2.8));
    push(bulge,{aArm:[0,1,1,1],aOrbit:[0,0,0,0],aColor:[tone.r,tone.g,tone.b],aSize:.035+Math.pow(bulgeRandom(),4)*.07,aBright:i>=7400?.1+bulgeRandom()*.16:(.5+bulgeRandom()*.5)*(1.25-Math.min(1,r/3)*.6),aSeed:bulgeRandom()});
  }
  const group=new THREE.Group(),layers={};
  const add=(name,target,mat,kind=THREE.Points,order=0)=>{
    const geometry=target.fields.position?(()=>{const g=new THREE.BufferGeometry();for(const [n,size] of Object.entries(target.fields))g.setAttribute(n,new THREE.BufferAttribute(target.data[n],size));g.boundingSphere=new THREE.Sphere(new THREE.Vector3(),R);return g;})():geometryOf(target);
    const object=new kind(geometry,mat);object.renderOrder=order;object.frustumCulled=false;group.add(object);layers[name]=object;
  };
  add('gas',gas,material(shared({uStretch:{value:3.2},uDark:{value:0}}),CLOUD_VERTEX,CLOUD_FRAGMENT),THREE.Points,1);
  add('lanes',lanes,material(shared({uStretch:{value:3.4},uDark:{value:1}}),CLOUD_VERTEX,CLOUD_FRAGMENT,THREE.NormalBlending),THREE.Points,2);
  add('lines',lines,material(shared({uColor:{value:new THREE.Color(0x9cc8ff)}}),LINE_VERTEX,LINE_FRAGMENT),THREE.LineSegments,3);
  add('bulge',bulge,material(shared({}),BULGE_VERTEX,STAR_FRAGMENT),THREE.Points,3);
  add('stars',stars,material(shared({}),STAR_VERTEX,STAR_FRAGMENT),THREE.Points,4);
  add('hii',hii,material(shared({uStretch:{value:1.3},uDark:{value:0}}),CLOUD_VERTEX,CLOUD_FRAGMENT),THREE.Points,5);
  add('commits',commits,material(shared({}),COMMIT_VERTEX,COMMIT_FRAGMENT),THREE.Points,6);
  const materials=Object.values(layers).map(object=>object.material);
  return {
    group,layers,
    update(seconds,pattern,viewport){for(const m of materials){m.uniforms.uTime.value=seconds;m.uniforms.uPattern.value=pattern;m.uniforms.uViewport.value=viewport;}},
    // factor: 0 hidden … 1 normal … 2 highlighted, stored at half scale in an 8-bit texture.
    setArms(factors){for(let i=0;i<count;i++)stateData[i*4]=Math.round(Math.max(0,Math.min(2,factors[i]??1))*127.5);armState.needsUpdate=true;},
    dispose(){armState.dispose();for(const object of Object.values(layers)){object.geometry.dispose();object.material.dispose();}}
  };
}

// Repository drill-down: commit satellites drawn with the same star/glint optics as the overview commits.
export function createSatelliteStars(entries){
  const count=Math.max(1,entries.length),position=new Float32Array(count*3),color=new Float32Array(count*3),size=new Float32Array(count),flags=new Float32Array(count*2);
  entries.forEach((entry,i)=>{position.set([entry.position.x,entry.position.y,entry.position.z],i*3);color.set([entry.color.r,entry.color.g,entry.color.b],i*3);
    size[i]=entry.size;flags.set([entry.head?1:0,i],i*2);});
  const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(position,3));
  geometry.setAttribute('aColor',new THREE.BufferAttribute(color,3));geometry.setAttribute('aSize',new THREE.BufferAttribute(size,1));geometry.setAttribute('aFlags',new THREE.BufferAttribute(flags,2));
  geometry.setDrawRange(0,entries.length);
  const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,depthTest:false,blending:THREE.AdditiveBlending,
    uniforms:{uTime:{value:0},uReveal:{value:1},uViewport:{value:900},uSelected:{value:-1},uOpacity:{value:1}},
    vertexShader:`attribute vec3 aColor;attribute float aSize;attribute vec2 aFlags;uniform float uTime;uniform float uReveal;uniform float uViewport;uniform float uSelected;uniform float uOpacity;
      varying vec3 vColor;varying float vAlpha;varying float vGlint;
      void main(){vec4 mv=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*mv;float selected=abs(aFlags.y-uSelected)<.5?1.:0.;
        vGlint=max(aFlags.x*.75,selected);float pulse=.85+.15*sin(uTime*1.3+aFlags.y*1.7);
        vAlpha=uReveal*uOpacity*pulse*(.75+selected*.6);vColor=aColor;
        gl_PointSize=clamp(aSize*(1.+selected*.5)*projectionMatrix[1][1]*uViewport*.5/max(.5,-mv.z)*(vGlint>0.?7.:3.2)*uReveal,2.,220.);}`,
    fragmentShader:COMMIT_FRAGMENT});
  const points=new THREE.Points(geometry,material);points.frustumCulled=false;points.renderOrder=6;
  return {points,viewport:new THREE.Vector2(),
    update(seconds,reveal,viewport,selected){const u=material.uniforms;u.uTime.value=seconds;u.uReveal.value=reveal;u.uViewport.value=viewport;u.uSelected.value=selected;}};
}

// Selected repository: its full commit history rides along its own arm (same arm function as the overview).
export function createArmCommitStars(item,sources,colors){
  const count=Math.max(1,sources.length),one=new THREE.DataTexture(new Uint8Array([255,255,255,255]),1,1,THREE.RGBAFormat);one.needsUpdate=true;
  const target=layer(count,{aFlags:2}),cot=1/Math.tan(item.pitchDegrees*Math.PI/180);
  sources.forEach((source,i)=>push(target,{aArm:[item.index,item.count,cot,GALAXY_ARMS.minRadius],aOrbit:[source.radius,source.lateral,source.depth,source.phase],
    aColor:[colors[i].r,colors[i].g,colors[i].b],aSize:source.size,aBright:1,aSeed:(i*.618)%1,aFlags:[source.head?1:0,i]}));
  const geometry=geometryOf(target);geometry.setDrawRange(0,sources.length);
  const material=new THREE.ShaderMaterial({transparent:true,depthWrite:false,depthTest:false,blending:THREE.AdditiveBlending,
    uniforms:{uTime:{value:0},uPattern:{value:0},uViewport:{value:900},uOpacity:{value:1},uArmCount:{value:1},uArmState:{value:one},uReveal:{value:0},uSelected:{value:-1},uHover:{value:-1}},
    vertexShader:ARM_GLSL+`attribute vec3 aColor;attribute float aSize;attribute float aSeed;attribute vec2 aFlags;uniform float uReveal;uniform float uSelected;uniform float uHover;
      varying vec3 vColor;varying float vAlpha;varying float vGlint;varying float vFocus;varying float vSeed;
      void main(){vec3 p=armPointAt(aOrbit.x,aOrbit.y);vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;
        float selected=abs(aFlags.y-uSelected)<.5?1.:0.,hover=abs(aFlags.y-uHover)<.5?1.:0.,focus=max(selected,hover*.7);
        float wave=smoothstep(0.,.25,uReveal*1.25-aOrbit.x/${GALAXY_ARMS.outerRadius.toFixed(1)});
        vGlint=max(aFlags.x*.8,focus);vAlpha=wave*uOpacity*1.3*(.95+.15*sin(uTime*1.4+aSeed*40.))*(1.+focus*.8);vColor=aColor;
        gl_PointSize=clamp(aSize*1.25*(1.+focus*.6)*pixels(mv)*7.,10.,220.);vFocus=focus;vSeed=aSeed;}`,
    fragmentShader:`varying vec3 vColor;varying float vAlpha;varying float vGlint;varying float vFocus;varying float vSeed;uniform float uTime;
      void main(){vec2 uv=(gl_PointCoord-.5)*2.;float d=length(uv),q=d*7./3.2;
        float core=exp(-q*q*16.)*1.7,halo=exp(-q*2.4)*.4;vec2 a=abs(uv);
        float spikes=vGlint>0.?(exp(-a.y*90.)*pow(max(0.,1.-a.x),3.)+exp(-a.x*90.)*pow(max(0.,1.-a.y),3.))*.9*vGlint:0.;
        float pulse=.5+.5*sin(uTime*2.2+vSeed*30.),ringR=.3+.04*pulse+vFocus*.08;
        float ring=exp(-pow((d-ringR)*38.,2.))*(.32+.25*pulse+vFocus*.6);
        gl_FragColor=vec4((vColor*(core+halo+ring)+mix(vColor,vec3(1.),.5)*spikes)*vAlpha*(1.-smoothstep(.9,1.,d)),1.);}`});
  const points=new THREE.Points(geometry,material);points.frustumCulled=false;points.renderOrder=8;
  return {points,viewport:new THREE.Vector2(),
    update(seconds,pattern,reveal,viewport,selected,hover){const u=material.uniforms;u.uTime.value=seconds;u.uPattern.value=pattern;u.uReveal.value=reveal;u.uViewport.value=viewport;u.uSelected.value=selected;u.uHover.value=hover;},
    dispose(){one.dispose();}};
}
