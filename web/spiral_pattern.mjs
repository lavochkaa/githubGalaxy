export const SPIRAL_PATTERN=Object.freeze({
  armCount:2,
  aspect:.68,
  minRadius:1.2,
  pitchDegrees:15,
  omega:-(Math.PI*2)/(210)
});

const pitch=SPIRAL_PATTERN.pitchDegrees*Math.PI/180;
const cotPitch=1/Math.tan(pitch);
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

export function patternAngle(seconds=0){return SPIRAL_PATTERN.omega*seconds;}
export function localDrift(radius,phase,seconds=0){
  const speed=.016/(1+radius/7);
  return clamp(.24*Math.sin(seconds*speed+phase),-.35,.35);
}
export function spiralPoint({arm,radius,lateral=0,z=0,phase=0},seconds=0,drift=localDrift(radius,phase,seconds)){
  const adjustedRadius=radius*Math.exp(drift*Math.tan(pitch));
  const theta=arm*Math.PI*2/SPIRAL_PATTERN.armCount+cotPitch*Math.log(adjustedRadius/SPIRAL_PATTERN.minRadius)+patternAngle(seconds)+drift;
  const x=Math.cos(theta)*adjustedRadius-Math.sin(theta)*lateral;
  const y=(Math.sin(theta)*adjustedRadius+Math.cos(theta)*lateral)*SPIRAL_PATTERN.aspect;
  return {x,y,z,theta,radius:adjustedRadius};
}
export function centerlineDeviation(samples,seconds=600){
  let maximum=0,outer=0;
  for(const sample of samples){const atZero=spiralPoint(sample,0,0),atTime=spiralPoint(sample,seconds,0);
    const inverse=-patternAngle(seconds),c=Math.cos(inverse),s=Math.sin(inverse);
    const x=atTime.x*c-(atTime.y/SPIRAL_PATTERN.aspect)*s;
    const y=(atTime.x*s+(atTime.y/SPIRAL_PATTERN.aspect)*c)*SPIRAL_PATTERN.aspect;
    maximum=Math.max(maximum,Math.hypot(x-atZero.x,y-atZero.y));outer=Math.max(outer,sample.radius);
  }
  return {maximum,outer,ratio:outer?maximum/outer:0};
}
