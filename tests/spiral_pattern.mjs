import assert from 'node:assert/strict';
import {SPIRAL_PATTERN,centerlineDeviation,localDrift,patternAngle,spiralPoint} from '../web/spiral_pattern.mjs';

const samples=Array.from({length:64},(_,index)=>({
  arm:index%SPIRAL_PATTERN.armCount,
  radius:SPIRAL_PATTERN.minRadius+index*.31,
  phase:index*.73
}));
const shape=centerlineDeviation(samples,600);
assert(shape.ratio<.01,`spiral centerline drifted ${shape.ratio*100}% after ten minutes`);
assert.equal(patternAngle(210),-Math.PI*2,'the pattern must complete one clockwise revolution in 210 seconds');
assert(Math.abs(localDrift(4,1.4,600))<=.35,'local drift must remain bounded around the arm centerline');
const origin=spiralPoint(samples[0],0,0),afterCycle=spiralPoint(samples[0],210,0);
assert(Math.hypot(origin.x-afterCycle.x,origin.y-afterCycle.y)<1e-9,'the rigid pattern must return to its initial position after one cycle');
console.log('Spiral pattern: ten-minute shape stability and clockwise cycle passed');
