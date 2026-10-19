export const GALAXY_ARMS=Object.freeze({minRadius:2.15,outerRadius:18,pitchDegrees:20,aspect:.78,
  omega:-(Math.PI*2)/(210),maxDrift:.35});

const TAU=Math.PI*2;
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
const hash=value=>{let n=2166136261;for(const char of String(value))n=Math.imul(n^char.charCodeAt(0),16777619);return n>>>0;};
const random=value=>((Math.sin(value)*43758.5453123)%1+1)%1;

export function patternAngle(seconds=0){return GALAXY_ARMS.omega*seconds;}
export function armDrift(radius,phase,seconds=0){
  const speed=.05/(1+radius/7);
  return clamp(.24*Math.sin(seconds*speed+phase),-GALAXY_ARMS.maxDrift,GALAXY_ARMS.maxDrift);
}

// One shared pitch and phase origin keep the arms evenly interleaved; per-arm variance made them bunch up and leave voids.
function armPitchDegrees(index){return GALAXY_ARMS.pitchDegrees+((hash(index+'pitch')%1000)/1000-.5)*.3;}
export function armSpacing(arm,radius){return TAU*radius/Math.max(1,arm.count)*Math.sin((arm.pitchDegrees||GALAXY_ARMS.pitchDegrees)*Math.PI/180);}
export function armSigma(arm,radius){const spacing=TAU*radius/Math.max(1,arm.count)*Math.sin(18*Math.PI/180),disc=arm.outerRadius||GALAXY_ARMS.outerRadius;
  return Math.min(spacing/3.5,clamp(spacing*(.18+(hash(arm.repo?.name||arm.arm)%1000)/1000*.04),disc*.004,disc*.025));}
export function minimumArmGap(arms,radius){return Math.min(...arms.map(arm=>armSpacing(arm,radius)));}

export function galaxyArmPointInto(target,{arm,count,radius,lateral=0,depth=0,phase=0,pitchDegrees=GALAXY_ARMS.pitchDegrees,innerRadius=GALAXY_ARMS.minRadius},seconds=0,drift=armDrift(radius,phase,seconds)){
  const pitch=pitchDegrees*Math.PI/180,cotPitch=1/Math.tan(pitch),adjustedRadius=radius*Math.exp(drift*Math.tan(pitch));
  const theta=arm*TAU/Math.max(1,count)+cotPitch*Math.log(adjustedRadius/GALAXY_ARMS.minRadius)+patternAngle(seconds)+drift;
  target.set(Math.cos(theta)*adjustedRadius-Math.sin(theta)*lateral,
    (Math.sin(theta)*adjustedRadius+Math.cos(theta)*lateral)*GALAXY_ARMS.aspect,depth);
  target.theta=theta;target.radius=adjustedRadius;return target;
}
export function galaxyArmPoint(source,seconds=0,drift=armDrift(source.radius,source.phase,seconds)){
  return galaxyArmPointInto({set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}},source,seconds,drift);
}

function dustFor(repo,index,count,innerRadius,pitchDegrees){
  const total=Math.max(54,Math.min(96,Math.round(54+Math.sqrt(Math.max(0,repo.commits||0))*4)));
  const seed=hash(repo.fullName||repo.name||index),dust=[];
  for(let particle=0;particle<total;particle++){
    const u=(particle+.5)/total,noise=random(seed+particle*19.17),radius=innerRadius+(GALAXY_ARMS.outerRadius-innerRadius)*u;
    const gaussian=(random(seed+particle*7.7)+random(seed+particle*11.9)+random(seed+particle*17.3)-1.5)/1.5;
    const sigma=armSigma({arm:index,count,pitchDegrees,outerRadius:GALAXY_ARMS.outerRadius,repo},radius),knot=((particle*7+seed)%Math.max(7,Math.floor(total/6)))===0;
    dust.push({arm:index,count,radius,lateral:gaussian*sigma,depth:gaussian*(.06+radius*.022),innerRadius,pitchDegrees,
      phase:random(seed+particle*3.1)*TAU,knot,size:knot?1.3+noise*1.2:.35+noise*.5});
  }
  return dust;
}

export function commitsFor(repo,index,count,innerRadius,pitchDegrees){
  const commits=repo.overviewCommits||[],last=Math.max(1,commits.length-1);
  return commits.map((commit,commitIndex)=>{
    const age=1-commitIndex/last;
    const radius=innerRadius+(GALAXY_ARMS.outerRadius-innerRadius)*(.17+age*.76);
    const lateral=((hash(commit.oid||commitIndex)%1000)/1000-.5)*(.06+radius*.012);
    return {commit,commitIndex,arm:index,count,radius,lateral,depth:((hash((commit.oid||'')+'depth')%1000)/1000-.5)*(.08+radius*.022),innerRadius,pitchDegrees,
      phase:(hash((commit.oid||'')+'phase')%1000)/1000*TAU};
  });
}

export function buildGalaxyArms(repositories){
  const ordered=[...repositories].sort((a,b)=>Date.parse(b.pushedAt||0)-Date.parse(a.pushedAt||0)||String(a.name).localeCompare(String(b.name)));
  return ordered.map((repo,index)=>{const innerRadius=GALAXY_ARMS.outerRadius*(.06+(hash(repo.fullName||repo.name)%1000)/1000*.19),pitchDegrees=armPitchDegrees(repo.fullName||repo.name);
    return {repo,index,count:ordered.length,outerRadius:GALAXY_ARMS.outerRadius,innerRadius,pitchDegrees,
      dust:dustFor(repo,index,ordered.length,innerRadius,pitchDegrees),commits:commitsFor(repo,index,ordered.length,innerRadius,pitchDegrees),
      label:{arm:index,count:ordered.length,radius:GALAXY_ARMS.outerRadius+.45,lateral:0,depth:0,phase:0,innerRadius,pitchDegrees}};});
}

export function nearestArm(arms,x,y,seconds=0){
  const r=Math.hypot(x,y/GALAXY_ARMS.aspect),angle=Math.atan2(y/GALAXY_ARMS.aspect,x);let best=null,distance=Infinity;
  for(const arm of arms){if(r<arm.innerRadius*.75||r>arm.outerRadius*1.08)continue;
    const cot=1/Math.tan(arm.pitchDegrees*Math.PI/180),theta=arm.index*TAU/Math.max(1,arm.count)+cot*Math.log(r/GALAXY_ARMS.minRadius)+patternAngle(seconds);
    const gap=Math.abs(((angle-theta)%TAU+TAU*1.5)%TAU-Math.PI)*r;if(gap<distance){distance=gap;best=arm;}}
  return best?{arm:best,distance,radius:r}:null;
}
export function centerlineDeviation(samples,seconds=600){
  let maximum=0,outer=0;const inverse=-patternAngle(seconds),c=Math.cos(inverse),s=Math.sin(inverse);
  for(const sample of samples){
    const atZero=galaxyArmPoint(sample,0,0),atTime=galaxyArmPoint(sample,seconds,0);
    const x=atTime.x*c-(atTime.y/GALAXY_ARMS.aspect)*s;
    const y=(atTime.x*s+(atTime.y/GALAXY_ARMS.aspect)*c)*GALAXY_ARMS.aspect;
    maximum=Math.max(maximum,Math.hypot(x-atZero.x,y-atZero.y));outer=Math.max(outer,sample.radius);
  }
  return {maximum,outer,ratio:outer?maximum/outer:0};
}
