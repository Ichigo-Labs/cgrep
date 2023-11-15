#!/usr/bin/env ts-node
import ts from 'typescript';
import fs from 'fs';
import path from 'path';
import ignore from 'ignore';
import { Command } from 'commander';
import child_process from 'child_process';
const exec = child_process.execSync;
const version = '1.0.0';

// Parse CLI args.
const program = new Command();
program
	.description('Checks project files against cgrep rules.')
	.name('cgrep')
	.version(version)
	.option('-s, --staged', 'only check git staged files')
	.option('-d, --debug', 'print debug information')
	.option('-p, --project <path>', 'path to tsconfig.json')
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
		console.log(`[cgrep failure] cwd not found at ${cwdPath}`);
		process.exit(1);
	}
}

let checkStatus = 0; // Set to 1 if any step goes wrong.
const projectRoot = options.cwd || process.cwd();
const fullFilePaths: string[] = [];

const gitignore = ignore().add(getGitIgnoreRules(projectRoot));
const projectFiles = getProjectFiles(projectRoot, gitignore);

if (options.staged) {
	const stagedFiles = exec('git diff --staged --name-only', { encoding: 'utf8' })
		.toString()
		.split('\n')
		.filter((x) => x);
	fullFilePaths.push(...stagedFiles);
} else {
	fullFilePaths.push(...projectFiles);
}

doChecks().then(() => {
	process.exit(checkStatus);
});

async function doChecks() {
	const checks = await importCgrepFiles(projectFiles);

	for (const fileToCheck of fullFilePaths) {
		const fileToCheckPath = path.resolve(projectRoot, fileToCheck);
		let fileContents: string;
		try {
			fileContents = fs.readFileSync(fileToCheckPath, { encoding: 'utf-8' });
		} catch {
			// File was locked, didn't exist, etc. Do nothing.
			continue;
		}

		// Eg ['C:', 'foo', 'bar', 'example.js'] (or "home", "admin", "example.js" on *nix).
		const filePathSegments: string[] = fileToCheckPath.split(path.sep);

		// Eg 'example'. Extension not included.
		const fileName = filePathSegments.pop()?.replace(/\.[^/.]+$/, '');

		// Eg 'C:\foo\bar'. Trailing slash not included. Filename not included.
		const filePath = path.join(...filePathSegments);

		// Eg 'js'. Leading period not included.
		const fileExtension = (fileName && path.extname(fileToCheckPath).substring(1)) || '';

		const file = Object.freeze({
			fileContents,
			filePath,
			fileName,
			fileExtension,
		});

		const isCheckFile =
			(fileName === 'cgrep.config' ||
				fileName?.endsWith('.cgrep.check') ||
				fileExtension === '.cgreprc') &&
			['js', 'ts'].includes(fileExtension);
		if (isCheckFile) continue; // Omit cgrep files from checks.

		if (options.debug) console.log(`Checking: ${fileToCheck}`);

		const lineNumberRanges = getLineNumberRanges(fileContents);

		const boundLogToConsole = (
			regexOrText: RegExp | string,
			checkMessage: string,
			alert?: 'error' | 'warn' | 'warning' | 'info'
		) =>
			logToConsole(regexOrText, checkMessage, fileToCheck, fileContents, lineNumberRanges, alert);

		for (const check of checks) {
			check({ ...file, underline: boundLogToConsole });
		}
	}
}

async function importCgrepFiles(fullFilePath: string[]) {
	const checks: Function[] = [];

	// Look for cgrep files.
	for (const filePath of fullFilePath) {
		const fileExtension = path.extname(filePath);
		const fileName = path.basename(filePath, fileExtension);
		const isCheckFile =
			(fileName === 'cgrep.config' ||
				fileName?.endsWith('.cgrep.check') ||
				fileExtension === '.cgreprc') &&
			['.js', '.ts'].includes(fileExtension);

		if (!isCheckFile) continue;

		try {
			let javascriptString = '';
			const fileContents = fs.readFileSync(filePath, { encoding: 'utf-8' });
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
				console.log(`Imported: ${filePath} containing ${evalChecks.length} check(s).`);

			checks.push(...evalChecks);
		} catch (e) {
			console.log(
				`[cgrep failure] error processing ${filePath}\nError message: ${e.message}\nStack: ${e.stack}\n`
			);
		}
	}

	return checks;
}

function logToConsole(
	regexOrText: RegExp | string,
	checkMessage: string,
	filePath: string,
	fileContents: string,
	lineNumberRanges: number[],
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
		typeof regexOrText === 'string' ? new RegExp(escapeRegExp(regexOrText), 'g') : regexOrText;
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
	if (
		alertLevel !== 'error' &&
		alertLevel !== 'warn' &&
		alertLevel !== 'warning' &&
		alertLevel !== 'info'
	)
		alertLevel = 'error'; // Default to error.

	// Console color codes.
	const redTextColor = '\x1b[31m';
	const yellowTextColor = '\x1b[33m';
	const cyanTextColor = '\x1b[36m';
	const resetColor = '\x1b[0m';

	let alertTextColor;
	if (alertLevel === 'error') alertTextColor = redTextColor;
	else if (alertLevel === 'warn' || alertLevel === 'warning') alertTextColor = yellowTextColor;
	else if (alertLevel === 'info') alertTextColor = cyanTextColor;

	console.log(`${alertTextColor}${alertLevel}${resetColor} ${checkMessage}`);

	for (const checkInfo of checkMatches) {
		if (alert === 'error') checkStatus = 1;
		const lineNumber = getLineNumber(checkInfo.startPosition, lineNumberRanges);
		console.log(`@\n${filePath}:${lineNumber}\n${checkInfo.matchString}`);
	}
}

/*
* Input: "hello\n World how\n are you?"
* Output: [
	0,7, 	// 'hello\n', 		line 1 [start index:end index]
	8,19, 	// ' World how\n'	line 2 [start index:end index]
	20,28 	// ' are you?' 		line 3 [start index:end index]
]
*/
function getLineNumberRanges(fileContents: string) {
	let index = 0;
	const lineNumberRanges = fileContents.split('\n').flatMap((line) => {
		const lineStartIndex = index;
		// Typically one should avoid mutation in maps, but who's watching?
		index = index + line.length + '\n'.length;
		const lineEndIndex = index;

		return [lineStartIndex, lineEndIndex];
	});

	// Fix last lineEndIndex.
	// If file contents don't end with "\n", lineEndIndex is too large.
	if (!fileContents.endsWith('\n')) lineNumberRanges[lineNumberRanges.length - 1] -= '\n'.length;

	return lineNumberRanges;
}

function getLineNumber(position: number, lineNumberRanges: number[]) {
	const lastIndex = lineNumberRanges.length - 1;
	const rangeMax = lineNumberRanges[lastIndex];
	if (position > rangeMax)
		throw new Error(`index of ${position} must not be greater than rangeMax of ${rangeMax}`);
	if (position < 0) throw new Error('index must be non-negative.');

	// Simple binary search for lowerbound.
	let leftIndex = 0;
	let rightIndex = lastIndex;
	while (leftIndex <= rightIndex) {
		const middleIndex = Math.floor((rightIndex + leftIndex) / 2);
		if (lineNumberRanges[middleIndex] < position) leftIndex = middleIndex + 1;
		else rightIndex = middleIndex - 1;
	}

	// Each line has a start and end position in the lineNumberRanges array,
	// so divide the leftIndex by 2, add 1, and take the floor to get the associated line number.
	const lineNumber = Math.floor(leftIndex / 2 + 1);
	return lineNumber;
}

function getProjectFiles(directoryPath: string, gitignoreRules: any) {
	const files: string[] = [];
	iterateProjectFiles(directoryPath, gitignoreRules, (file) => files.push(file));
	return files;
}

function iterateProjectFiles(
	directoryPath: string,
	gitignoreRules: any,
	onFile: (file: string) => void
) {
	const files = fs.readdirSync(directoryPath);
	const filteredFiles = filterFiles(
		directoryPath,
		files.map((file) => path.join(directoryPath, file)),
		gitignoreRules
	);

	for (const file of filteredFiles) {
		if (fs.statSync(file).isDirectory()) {
			getProjectFiles(file, gitignoreRules);
		} else {
			if (options.debug) console.log(`Added: ${file}`);
			onFile(file);
		}
	}
}

function getGitIgnoreRules(directoryPath: string) {
	const gitIgnorePath = path.join(directoryPath, '.gitignore');
	let rules: string[] = [];

	try {
		const gitIgnoreContent = fs.readFileSync(gitIgnorePath, 'utf-8');
		rules = gitIgnoreContent.split('\n');
	} catch (error) {
		// .gitignore file doesn't exist, or was locked, deleted, etc.
	}

	return rules;
}

function filterFiles(directoryPath: string, fileNames: string[], gitignore: any) {
	return fileNames.filter((file) => !gitignore.ignores(path.relative(directoryPath, file)));
}

// Copied from MDN docs.
function escapeRegExp(theString: string) {
	return theString.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}