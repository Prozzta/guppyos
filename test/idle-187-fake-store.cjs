'use strict';
// IDLE-MEANS-IDLE-187 (Jim's audit probe, adopted): a store whose hook is a plain selector call over a settable state.
let state = { liveness: {}, agents: [], heavyLock: null };
exports.setState = (s) => { state = { ...state, ...s }; };
exports.useStore = (sel) => sel(state);
