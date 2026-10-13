/**
 * Processor time, as a reference machine would have used it: the one helper the timing tests of
 * both packages use, kept in the core package's tests (where it is itself tested). It is re-exported
 * and not copied, so that recalibrating it on a new runner changes every timing test at once and
 * none is left with the old calibration.
 */
export { SLOWNESS, cpuNow } from '../../../core/test/cpu-time.js';
