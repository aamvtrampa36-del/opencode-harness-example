import test from 'node:test';
import assert from 'node:assert/strict';
import { add } from './add.mjs';
test('G9: add(2,3) is five', () => assert.equal(add(2, 3), 5));
