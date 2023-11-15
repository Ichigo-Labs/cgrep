#!/usr/bin/env node
const path = require('path');
require('ts-node').register({
	// Use the dist/tsconfig.json
	project: path.resolve(__dirname),
});
require('./cli-cgrep.ts');
