import assert from 'node:assert/strict';
import {buildGalaxyArms, centerlineDeviation, galaxyArmPoint, galaxyArmPointInto, armSigma, minimumArmGap} from '../web/galaxy_arm_layout.mjs';

const repos=[
  {name:'alpha',language:'Swift',pushedAt:'2026-10-18T10:00:00Z',commits:92,overviewCommits:[{oid:'a1',date:'2026-01-01T00:00:00Z',additions:2,deletions:1}]},
  {name:'beta',language:'Rust',pushedAt:'2026-10-17T10:00:00Z',commits:1,overviewCommits:[{oid:'b1',date:'2026-10-01T00:00:00Z',additions:100,deletions:3}]},
  {name:'empty',language:'Python',pushedAt:null,commits:0,overviewCommits:[]},
];
const arms=buildGalaxyArms(repos);
assert.equal(arms.length,3,'one arm is allocated for every repository');
assert.equal(new Set(arms.map(arm=>arm.index)).size,3,'arm indices are unique');
assert.equal(new Set(arms.map(arm=>arm.outerRadius)).size,1,'all arms have one fixed length');
assert(arms.every(arm=>arm.dust.length>0),'even empty repositories retain faint full-length dust arms');
assert.equal(arms[0].commits[0].commit.oid,'a1','real overview commits become bright stars');
assert(centerlineDeviation(arms.map(arm=>({arm:arm.index,count:arms.length,radius:arm.outerRadius})),600).ratio<.01,'rigid rotation preserves arm geometry for ten minutes');
const a=galaxyArmPoint({arm:0,count:3,radius:9,lateral:0,depth:0,phase:0},0,0);
const b=galaxyArmPoint({arm:0,count:3,radius:9,lateral:0,depth:0,phase:0},600,0);
assert.notDeepEqual([a.x,a.y],[b.x,b.y],'the shared angle rotates the arm pattern');
const reusable={set(x,y,z){this.x=x;this.y=y;this.z=z;return this;}};
assert.equal(galaxyArmPointInto(reusable,{arm:0,count:3,radius:9,lateral:0,depth:0,phase:0},600,0),reusable,'point updates reuse the caller vector');
assert.deepEqual([reusable.x,reusable.y,reusable.z],[b.x,b.y,b.z],'reused points preserve the arm coordinates');
for(const count of [12,21,40,100]){
  const inventory=Array.from({length:count},(_,index)=>({name:`repo-${index}`,fullName:`space/repo-${index}`,language:'Swift',commits:index,overviewCommits:[]}));
  const layout=buildGalaxyArms(inventory);
  for(const fraction of [.3,.5,.7,.9]){
    const radius=layout[0].outerRadius*fraction,gap=minimumArmGap(layout,radius),sigma=Math.max(...layout.map(arm=>armSigma(arm,radius)));
    assert(gap>=3.5*sigma-1e-8,`${count} arms keep a 3.5σ dark gap at ${fraction}R`);
  }
}
assert(arms.every(arm=>arm.innerRadius>=arms[0].outerRadius*.06&&arm.innerRadius<=arms[0].outerRadius*.25),'arm starts leave a deterministic dark core gap');
console.log('Galaxy arm layout: dynamic repository arms, equal length, real commits and rigid rotation passed');
