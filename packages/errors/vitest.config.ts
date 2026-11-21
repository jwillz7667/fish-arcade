// Relative import on purpose: see tsconfig.json for why errors does not depend on @reef/config.
import { createVitestProject } from '../config/src/vitest.js';

export default createVitestProject('errors');
