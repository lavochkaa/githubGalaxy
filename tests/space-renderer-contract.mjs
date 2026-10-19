import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../web/space_renderer.js',import.meta.url),'utf8');

assert.match(source,/sceneTarget/,'The base scene must have its own full-resolution render target.');
assert.match(source,/bloomTarget/,'Bloom must use a separate reduced-resolution target.');
assert.match(source,/sceneTarget\.setSize\(fullWidth,fullHeight\)/,
  'The base scene target must retain full resolution.');
assert.match(source,/bloomTarget\.setSize\(bloomWidth,bloomHeight\)/,
  'Only the bloom target may use half resolution.');
assert.match(source,/renderer\.setRenderTarget\(bloom\.sceneTarget\);renderer\.render\(scene,camera\);/,
  'The scene must first render into the sharp base target.');
assert.match(source,/renderer\.setRenderTarget\(bloom\.bloomTarget\);renderer\.render\(bloom\.extractScene,bloom\.camera\);/,
  'Bloom must be extracted from the base scene instead of rendering the base at half resolution.');

console.log('Space renderer keeps the base image sharp and bloom isolated at half resolution.');
