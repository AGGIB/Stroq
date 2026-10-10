// The one place the cli tests reach into the test directory of the core package for the clock that
// counts processor time (see there for why it is not the wall clock). A test that times something
// imports it from here, so that moving the clock later is one line to change and not an import in
// every file that uses it.
export { cpuNow } from '../../../core/test/cpu-time.js';
