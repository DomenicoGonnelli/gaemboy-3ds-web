import assert from 'node:assert/strict';
import test from 'node:test';
import { bindTouchControls } from '../web/gaemboy3ds-touch.js';

function harness() {
  const handlers = new Map();
  const root = {
    disabled: false,
    addEventListener(type, handler) { handlers.set(type, handler); },
    contains: () => true,
  };
  const controls = bindTouchControls(root);
  const element = (dataset) => ({
    dataset,
    classList: { add() {}, remove() {} },
    style: { setProperty() {}, removeProperty() {} },
    setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    closest() { return this; },
  });
  const fire = (type, target, pointerId, x = 50, y = 50) => handlers.get(type)({
    target, pointerId, pointerType: 'touch', clientX: x, clientY: y, preventDefault() {},
  });
  return { root, controls, element, fire };
}

test('touch buttons stay independent when multiple fingers hold and release them', () => {
  const { controls, element, fire } = harness();
  const a = element({ button: '8' }), right = element({ button: '7' });
  fire('pointerdown', a, 1);
  fire('pointerdown', right, 2);
  fire('pointerdown', a, 3);
  assert.equal(controls.read().buttons, (1 << 8) | (1 << 7));
  fire('pointerup', a, 1);
  assert.equal(controls.read().buttons, (1 << 8) | (1 << 7));
  fire('pointercancel', right, 2);
  assert.equal(controls.read().buttons, 1 << 8);
  fire('lostpointercapture', a, 3);
  assert.equal(controls.read().buttons, 0);
});

test('both analog sticks drag independently and clamp outside their circular bounds', () => {
  const { controls, element, fire } = harness();
  const left = element({ stick: 'left' }), right = element({ stick: 'right' });
  fire('pointerdown', left, 1, 100, 50);
  fire('pointerdown', right, 2, 50, 0);
  assert.deepEqual(controls.read().axes, [1, 0, 0, -1]);
  fire('pointermove', left, 1, 150, 150);
  const [x, y, rx, ry] = controls.read().axes;
  assert.ok(Math.abs(Math.hypot(x, y) - 1) < 1e-10);
  assert.ok(x > 0 && y > 0);
  assert.deepEqual([rx, ry], [0, -1]);
  fire('pointercancel', left, 1);
  assert.deepEqual(controls.read().axes, [0, 0, 0, -1]);
  fire('pointerup', right, 2);
  assert.deepEqual(controls.read().axes, [0, 0, 0, 0]);
});

test('reset clears held controls and disabled controls cannot start new input', () => {
  const { root, controls, element, fire } = harness();
  const start = element({ button: '3' }), stick = element({ stick: 'left' });
  fire('pointerdown', start, 1);
  fire('pointerdown', stick, 2, 0, 50);
  controls.reset();
  assert.deepEqual(controls.read(), { buttons: 0, axes: [0, 0, 0, 0] });
  root.disabled = true;
  fire('pointerdown', start, 3);
  assert.equal(controls.read().buttons, 0);
  root.disabled = false;
  fire('pointerdown', start, 4);
  assert.equal(controls.read().buttons, 1 << 3);
});
