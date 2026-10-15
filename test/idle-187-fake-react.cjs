'use strict';
// IDLE-MEANS-IDLE-187 (Jim's audit probe, adopted): just enough React for a hook called outside a renderer.
exports.useState = (init) => [typeof init === 'function' ? init() : init, () => {}];
exports.useEffect = () => {};
