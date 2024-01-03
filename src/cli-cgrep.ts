#!/usr/bin/env ts-node
import ts from 'typescript';
import fs from 'fs';
import path from 'path';
import { Command } from 'commander';
import child_process from 'child_process';
const exec = child_process.execSync;
const version = '2.0.0';

// Parse CLI args.
const program = new Command();
program
	.description('Checks project files against cgrep rules.')
	.name('cgrep')
	.version(version)
	.option('-s, --staged', 'only check git staged files')
	.option('-d, --debug', 'print debug information')
	.option('-p, --project <path>', 'path to tsconfig.json')
	.option('-g, --glob <pattern>', 'only check files matching glob pattern')
	.option('--cwd <path>', 'set the current working directory');
program.parse(process.argv);
const options = program.opts();

if (options.project) {
	// Check if tsconfig.json exists.
	const tsconfigPath = path.resolve(options.project);
	if (!fs.existsSync(tsconfigPath)) {
		console.log(`[cgrep failure] tsconfig.json not found at ${tsconfigPath}`);
		process.exit(1);
	}
}

if (options.cwd) {
	// Check if cwd exists.
	const cwdPath = path.resolve(options.cwd);
	if (!fs.existsSync(cwdPath)) {
		console.log(`[cgrep failure] valid cwd not found at ${cwdPath}`);
		process.exit(1);
	}
}

let checkStatus = 0; // Set to 1 if any step goes wrong or a check fails.
const cwd = options.cwd || process.cwd();

main().then(() => {
	process.exit(checkStatus);
});

async function main() {
	let files: string[] = [];

	if (options.staged) {
		files = exec('git diff --staged --name-only', { encoding: 'utf8' })
			.toString()
			.split('\n')
			.filter((x) => x);
	} else {
		files = await getProjectFiles(options.glob || '**/*');
	}

	const checks = await importCgrepChecks();

	for (const filePath of files) {
		let fileContents: string;
		try {
			fileContents = fs.readFileSync(filePath, { encoding: 'utf-8' });
		} catch {
			// File was locked, didn't exist, etc. Do nothing.
			continue;
		}

		// Eg 'example.js'.
		const fileName = path.basename(filePath);

		// Eg '.js'.
		const fileExtension = path.extname(filePath);

		const file = Object.freeze({
			fileContents,
			filePath,
			fileName,
			fileExtension,
		});

		const isCheckFile = fileName === 'cgrep.config.ts' || fileName === 'cgrep.config.js';
		if (isCheckFile) continue; // Omit cgrep files from checks.

		if (options.debug) console.log(`Checking: ${filePath}`);

		const lineNumberRanges = getLineNumberRanges(fileContents);

		const boundLogToConsole = (
			regexOrText: RegExp | string,
			checkMessage: string,
			alert?: 'error' | 'warn' | 'warning' | 'info'
		) => logToConsole(regexOrText, checkMessage, filePath, fileContents, lineNumberRanges, alert);

		for (const check of checks) {
			const result = check({ ...file, underline: boundLogToConsole });
			if (result === false) {
				checkStatus = 1;
			}
		}
	}
}

async function importCgrepChecks() {
	const checks: Function[] = [];
	let cgrepFile = path.resolve(cwd, 'cgrep.config.ts');
	if (!fs.existsSync(cgrepFile)) {
		cgrepFile = path.resolve(cwd, 'cgrep.config.js');
		if (!fs.existsSync(cgrepFile)) {
			console.log('cgrep.config.[ts,js] not found in current working directory.\n');
			process.exit(0);
		}
	}

	const fileExtension = path.extname(cgrepFile);

	try {
		let javascriptString = '';
		const fileContents = fs.readFileSync(cgrepFile, { encoding: 'utf-8' });
		if (fileExtension === '.js') {
			javascriptString = fileContents;
		} else if (fileExtension === '.ts') {
			let tsFileName;
			let tsConfigString;

			// If a tsconfig.json file is specified, use it instead.
			if (options.project) {
				tsFileName = path.basename(options.project, path.extname(options.project));
				tsConfigString = fs.readFileSync(options.project, { encoding: 'utf-8' });
			} else {
				tsFileName = 'tsconfig.json';
				tsConfigString = ts.sys.readFile('tsconfig.json', 'utf8');
			}

			const tsConfig = ts.parseConfigFileTextToJson(tsFileName, tsConfigString as string);
			const compiled = ts.transpileModule(fileContents, {
				compilerOptions: tsConfig.config.compilerOptions,
			});
			javascriptString = compiled.outputText;
		}
		const cgrepModule = await import(`data:text/javascript,${javascriptString}`);

		const evalChecks: Function[] = [];
		for (const key of Object.keys(cgrepModule)) {
			const evalCheck = cgrepModule[key];
			if (evalCheck instanceof Function) evalChecks.push(evalCheck);
		}

		if (options.debug)
			console.log(`Imported: ${cgrepFile} containing ${evalChecks.length} check(s).`);

		checks.push(...evalChecks);
	} catch (e) {
		console.log(`[cgrep failure] error processing ${cgrepFile}\nStack: ${e.stack}\n`);
	}

	return checks;
}

function logToConsole(
	regexOrText: RegExp | string,
	checkMessage: string,
	filePath: string,
	fileContents: string,
	lineNumberRanges: number[][],
	alert?: 'error' | 'warn' | 'warning' | 'info'
) {
	// Validate args passed in by consumers.
	if (typeof regexOrText !== 'string' && !(regexOrText instanceof RegExp)) {
		checkStatus = 1;
		console.log(
			'[Bad cgrep check] regexOrText must be a string or RegExp. Check your cgrep files.\n'
		);
		return;
	}

	if (typeof checkMessage !== 'string') {
		checkStatus = 1;
		console.log('[Bad cgrep check] checkMessage must be a string. Check your cgrep files.\n');
		return;
	}

	const regex =
		typeof regexOrText === 'string'
			? new RegExp(escapeRegExp(regexOrText), 'g')
			: new RegExp(regexOrText, 'g');
	const checkMatches: { startPosition: number; matchString: string }[] = [];

	const limit = 50;
	let counter = 0;
	let match;
	const existingMatches = new Set();
	while ((match = regex.exec(fileContents)) != null) {
		// Mitigate excessive backtracking cases.
		counter++;
		if (counter > limit) break;

		// Prevent regex expressions that infinitely loop.
		const matchIdentity = `${match.index}-${match[0].length}`;
		const loopDetected = existingMatches.has(matchIdentity);
		if (loopDetected) break;
		existingMatches.add(matchIdentity);

		const startPosition = match.index;
		const checkMatch = { startPosition, matchString: match[0] };
		checkMatches.push(checkMatch);
	}

	if (checkMatches.length === 0) return;

	let alertLevel = alert;
	if (alertLevel !== 'error' && alertLevel !== 'warn' && alertLevel !== 'info')
		alertLevel = 'error'; // Default to error.

	// Console color codes.
	const redTextColor = '\x1b[31m';
	const yellowTextColor = '\x1b[33m';
	const cyanTextColor = '\x1b[36m';
	const resetColor = '\x1b[0m';

	let alertTextColor;
	if (alertLevel === 'error') alertTextColor = redTextColor;
	else if (alertLevel === 'warn') alertTextColor = yellowTextColor;
	else if (alertLevel === 'info') alertTextColor = cyanTextColor;

	console.log(`\n${alertTextColor}${alertLevel}${resetColor} ${checkMessage}`);

	for (const checkInfo of checkMatches) {
		const lineNumber = getLineNumber(checkInfo.startPosition, lineNumberRanges);
		console.log(`${filePath}:${lineNumber}`);
	}
}

/*
Input: "hello\n World how\n are you?"
Output: [
	[0,7], 	// 'hello\n', 		line 1 [start index:end index]
	[7,19], 	// ' World how\n'	line 2 [start index:end index]
	[19,28] 	// ' are you?' 		line 3 [start index:end index]
]
*/
function getLineNumberRanges(fileContents: string) {
	let index = 0;
	const lineNumberRanges = fileContents.split('\n').map((line) => {
		const lineStartIndex = index;
		// Typically one should avoid mutation in maps, but who's watching?
		index = index + line.length + '\n'.length;
		const lineEndIndex = index;

		return [lineStartIndex, lineEndIndex];
	});

	return lineNumberRanges;
}

/**
 * @param position
 * 	Index of character in file contents
 * 	Example: 7, 25, etc.
 * @param lineNumberRanges
 * 	Array of start and end positions for each line.
 * 	Example: [[0,7], [7,19], [19,28]]
 * @returns line number
 */
function getLineNumber(position: number, lineNumberRanges: number[][]) {
	const lastIndex = lineNumberRanges.length - 1;

	// Simple binary search for lowerbound.
	let leftIndex = 0;
	let rightIndex = lastIndex;
	while (leftIndex <= rightIndex) {
		// Eg pick the middle index between 0 and 2.
		// [[0,7], [7,19], [19,28]] -> [7,19]
		const middleIndex = Math.floor((rightIndex + leftIndex) / 2);

		// Eg [7,19]
		const [startPosition, endPosition] = lineNumberRanges[middleIndex];
		if (startPosition <= position && position < endPosition) {
			const lineNumber = middleIndex + 1; // Add one because line numbers start at 1, not 0.
			return lineNumber;
		}
		if (endPosition <= position) {
			// Search right side.
			leftIndex = middleIndex + 1;
		} else {
			// Search left side.
			rightIndex = middleIndex - 1;
		}
	}
}

async function getProjectFiles(globPattern: string) {
	const p = await import('globby');

	try {
		return await p.globby([globPattern], {
			gitignore: true,
			cwd: cwd,
		});
	} catch (error) {
		console.error('Error:', error);
	}
}

// Copied from MDN docs.
function escapeRegExp(theString: string) {
	return theString.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}
