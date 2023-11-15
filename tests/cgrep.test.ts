import { cgrep } from '../src';
import { describe, it, expect } from 'vitest';

// Test utils.
function assert(condition) {
	if (!condition) {
		throw new Error();
	}
}

function assertMatch(regex, str) {
	if (!regex.test(str)) {
		throw new Error(`"${regex}" did not match:\n"${str}"`);
	}
}

function assertNotMatch(regex, str) {
	if (regex.test(str)) {
		throw new Error(`"${regex}" did match:\n"${str}"`);
	}
}

// Test "escape hatch" regex.
assertMatch(cgrep`5 + 5REGEX(3+)`, `5+53`);
assertMatch(cgrep`REGEX(3+9+2*) 5 + 5`, `392225+53`);

// Test complicated matching
assertMatch(
	cgrep`$#keyword ($1 $@ops1 $a) { return $a $@ops2 $2; }`,
	`
while (undefined === lineMatch) {
	return lineMatch / 55;
}`
);

assertMatch(cgrep`$#keyword($1$@ops1$2) { $$$ $1 $@ops1 $2 }`, `do(55 + "333") {55 + "333"}`);

// Test anonymous operator and keyword matching.
assertMatch(cgrep`$# ($a$@$a) { $1$@$2; }`, `while (a==a) { 1 / 2; }`);

// Test overlapping symbols, eg `+` in javascript vs `+` in regex.
assertMatch(cgrep`5+5*2`, `5 + 5 * 2`);

// Disallow assignment operators in conditional expressions.
assertMatch(cgrep`$$ ? $a = $b : $$`, `foobar ? var1 = var2 : 5`);
assertMatch(cgrep`$$ ? $$ : $a = $b`, `bazBar() ? bop() : foo = bar`);
assertNotMatch(cgrep`$$ ? $a = $b : $$`, `foobar ? getFunc() : baz`);

// Disallow constant expressions in conditions.
assertMatch(cgrep`if ($1$@op$2)`, `if (5+5)`);
assertMatch(cgrep`if ($1 $@op $2)`, `if (""+3.02)`);
assertMatch(cgrep`if ($1)`, `if(true)`);

// Disallow duplicate arguments in `function` definitions.
assertMatch(cgrep`function $a($b $$ $b)`, `function useFoo(first, second, first)`);
assertNotMatch(cgrep`function $a($b $$ $b)`, `function useFoo(first, second, third)`);

// Disallow duplicate case labels.
assertMatch(
	cgrep`
case $1:
	$$
case $1:
`,
	'case 5: console.log(333) break; case 5: break;'
);
assertNotMatch(
	cgrep`
case $1:
	$$
case $1:
`,
	'case 5: console.log(333) break; case 55: break;'
);

// Disallow reassigning exceptions in `catch` clauses.
assertMatch(cgrep`catch ($e) { $e = $$ }`, 'catch (e) { e = getError(); }');
assertNotMatch(cgrep`catch ($e) { $e = $$ }`, 'catch (e) { throw e; }');

// Disallow returning values from setters.
assertMatch(
	cgrep`set $a($$) { $$ return $$; }`,
	`set current(name) { console.log(name); return name; }`
);
assertNotMatch(cgrep`set $a($$) { $$ return $$; }`, `set current(name) { console.log(name); }`);

// Disallow returning values from Promise executor functions.
assertMatch(
	cgrep`
new Promise($$ => {
	$$ return $$; $$
});
`,
	`
new Promise((resolve, reject) => {
	if (someCondition) {
		return defaultResult;
	}
	getSomething((err, result) => {
		if (err) {
			reject(err);
		} else {
			resolve(result);
		}
	});
});
`
);

// Enforce a maximum depth that blocks can be nested.
assertMatch(
	cgrep`
{$$
	{$$
		{$$
			{
				$$
			}
		$$}
	$$}
$$}`,
	`
{
	let x = 5;
	{
		let y = 4;
		{
			let z = 10;
			{
				let f = 100.4;
			}
		}
	}
}`
);
assertNotMatch(
	cgrep`
{$$
	{$$
		{$$
			{
				$$
			}
		$$}
	$$}
$$}`,
	`
{
	if (a == b) {
		return true;
	}
}`
);

// Enforce consistent naming for boolean props.
assertMatch(
	cgrep`$a: PropTypes.bool$$`,
	`
MyComponent.propTypes = {
	optionalBool: PropTypes.bool,
	bazBar: PropTypes.number,
};`
);

// Prevent usage of button elements without an explicit type attribute.
testRequireTypeAttribute();
function testRequireTypeAttribute() {
	const sampleCodeBlock = `
<button type="button">Hello world.</button>
<button type="clickityClacker">Hello world.</button>
<button>Hello world.</button>`;

	const checkIsValid = (match) => match.blocks.every((x) => x.includes('type='));
	const validButtonCount = cgrep`<button $$>`.matchAll(sampleCodeBlock).filter(checkIsValid).length;

	assert(validButtonCount === 2);
}

// Enforce consistent usage of destructuring assignment of props, state, and context.
testRequirePropDestructing();
function testRequirePropDestructing() {
	const sampleCodeBlock = `
function ValidReactComponent(props, context) {
	const { propOne, propTwo, propThree } = props;
	return <div>{propOne + propTwo + propThree}</div>;
}
function InvalidReactComponent(props) {
	return <div>{props.propOne + props.propTwo}</div>;
}`;

	const checkIsValid = (match) => match.blocks.some((x) => x.includes('= props;'));
	const validComponentCount = cgrep`function $a($$ props $$) { $$$ }`
		.matchAll(sampleCodeBlock)
		.filter(checkIsValid).length;

	assert(validComponentCount === 1);
}

// Exported classes must end with `View`.
assertMatch(
	cgrep`export function $a View($$) { $$$ }`,
	`
export function HomepageView(props, context) {
	const { propOne, propTwo, propThree } = props;
	return <div>{propOne + propTwo + propThree}</div>;
}`
);
assertNotMatch(
	cgrep`export function $a View($$) { $$$ }`,
	`
export function Account(props) {
	return <div>{props.propOne + props.propTwo}</div>;
}`
);

// Enforce all defaultProps have a corresponding non-required PropType.
assertMatch(
	cgrep`propTypes = {$$ $a: $$.isRequired $$} $$ defaultProps = { $$ $a: $$ }`,
	`
class Greeting extends React.Component {
	render() {
	  return (
		<h1>Hello, {this.props.foo} {this.props.bar}</h1>
	  );
	}
  
	static propTypes = {
	  foo: React.PropTypes.string,
	  bar: React.PropTypes.string.isRequired
	};
  
	static defaultProps = {
	  bar: "baz"
	};
}`
);

// Prevent missing displayName in a React component definition.
testDisplayNameOnComponents();
function testDisplayNameOnComponents() {
	const sampleCodeBlock = `
export function HomepageView(props, context) {
	const { propOne, propTwo, propThree } = props;
	return <div>{propOne + propTwo + propThree}</div>;
}
HomepageView.displayName = "HomepageView";

export function Account(props) {
	return <div>{props.propOne + props.propTwo}</div>;
}`;

	const checkIsValid = (match) =>
		match.variables.every((x) => {
			const isReactComponent = /[A-Z]/.test(x[0]);
			const hasDisplayName = cgrep`${x}.displayName =`.matchAll(sampleCodeBlock).length !== 0;
			return isReactComponent && hasDisplayName;
		});
	const validDisplayNameCount = cgrep`export function $a($$) { $$ }`
		.matchAll(sampleCodeBlock)
		.filter(checkIsValid).length;

	assert(validDisplayNameCount === 1);
}

// Forbid certain props on Components (eg forbid className).
testForbidCertainProps();
function testForbidCertainProps() {
	const sampleCodeBlock = `
function FoobarComponent(props) {
	return <BigHeader className="veryCool" />;
}

function BazComponent(props) {
	return <div className="evenCooler" />;
}`;

	const checkIsValid = (match) =>
		match.variables.every((x) => {
			const isReactComponent = /[A-Z]/.test(x[0]);
			return !isReactComponent;
		});
	const validComponentCount = cgrep`function $$($$) { $$ <$a className=$$ }`
		.matchAll(sampleCodeBlock)
		.filter(checkIsValid).length;

	assert(validComponentCount === 1);
}

// Forbid certain elements (eg forbid `button`, prefer `Button`).
assertMatch(cgrep`<button $$>`, `<Button isValid /><button />`);
assertNotMatch(cgrep`<button $$>`, `<Button isValid />`);

// Prevent using this.state within a this.setState (eg use prevState).
assertMatch(
	cgrep`this.setState($$ this.state $$)`,
	`this.setState({ x: this.state.x, bar: this.state.bar });`
);
assertNotMatch(
	cgrep`this.setState($$ this.state $$)`,
	`this.setState(prevState => { x: prevState.x, bar: prevState.bar });`
);

// Prevent problem with children and props.dangerouslySetInnerHTML.
assertMatch(
	cgrep`<$$ dangerouslySetInnerHtml=$$>$$</$$>`,
	`<div dangerouslySetInnerHtml={foo} title="bar"><button /></div>`
);
assertNotMatch(
	cgrep`<$$ dangerouslySetInnerHtml=$$>$$</$$>`,
	`<div dangerouslySetInnerHtml={foo} title="bar" />`
);

// Enforce a defaultProps definition for every prop that is not a required prop.
testDefaultPropsForNonrequired();
function testDefaultPropsForNonrequired() {
	const sampleCodeBlock = `
// Valid.
function FoobarComponent(props) {
	return <BigHeader className="veryCool" />;
}
FoobarComponent.propTypes = {
	title: PropTypes.string,
};
FoobarComponent.defaultProps = {
	title: "This is a sensible default.",
};

// Not valid.
function BazComponent(props) {
	return <div className="evenCooler" />;
}
BazComponent.propTypes = {
	title: PropTypes.string,
};
BazComponent.defaultProps = {
	header: "Drink Ovaltine.",
};
`;

	const checkIsValid = (match) => {
		const propTypes = match.blocks[3];
		const defaultProps = match.blocks[5];

		const nonrequiredProps = cgrep`$a: $$`
			.matchAll(propTypes)
			.filter((x) => !x.blocks[0].includes('isRequired'))
			.map((x) => x.variables)
			.flat();
		const defaults = cgrep`$a: $$`
			.matchAll(defaultProps)
			.filter((x) => x.variables.every((variable) => nonrequiredProps.includes(variable)));

		return nonrequiredProps.length === defaults.length;
	};
	const validComponentCount =
		cgrep`function $a($$) { $$ } $$ $a.propTypes = { $$ } $$ $a.defaultProps = { $$ }`
			.matchAll(sampleCodeBlock)
			.filter(checkIsValid).length;

	assert(validComponentCount === 1);
}

// Enforce PascalCase for user-defined JSX components.
testEnforcePascalCase();
function testEnforcePascalCase() {
	const sampleCodeBlock = `
// Valid.
function FoobarComponent(props) {
	return <BigHeader className="veryCool" />;
}
function CoolComponent(props) {
	return (<BigHeader className="veryCool">Not bad!</BigHeader>);
}


// Not valid.
function notPascalCase(props) {
	return <div>Hello world</div>;
}
function NOTPASCALCASE(props) {
	return <div>Hello world</div>;
}`;

	const checkIsValid = (match) =>
		match.variables.every((x) => {
			const startsWithUpper = /[A-Z]/.test(x[0]);
			const followedByNoneOrNonupper = x.length === 1 ? true : !/[A-Z]/.test(x[1]);
			return startsWithUpper && followedByNoneOrNonupper;
		});
	const validComponentCount = cgrep`function $a($$) { $$<$$ }`
		.matchAll(sampleCodeBlock)
		.filter(checkIsValid).length;

	assert(validComponentCount === 2);
}

// Enforce defaultProps declarations alphabetical sorting.
testEnforceDefaultPropOrdering();
function testEnforceDefaultPropOrdering() {
	const sampleCodeBlock = `
// Valid.
function FoobarComponent(props) {
	return <BigHeader className="veryCool" />;
}
FoobarComponent.defaultProps = {
	a: "a",
	b: "b",
	c: "c",
	d: "d",
};

// Not valid.
function BazComponent(props) {
	return <div className="evenCooler" />;
}
BazComponent.defaultProps = {
	c: "c",
	b: "b",
	a: "a",
	d: "d",
};
`;

	const checkIsValid = (match) => {
		const defaultProps = match.blocks[match.blocks.length - 1];
		const defaults = cgrep`$a: $$`.matchAll(defaultProps).flatMap((x) => x.variables);
		const sortedDefaults = [...defaults].sort();
		return defaults.every((variable, i) => variable === sortedDefaults[i]);
	};
	const validComponentCount = cgrep`function $a($$) { $$ } $$ $a.defaultProps = { $$ }`
		.matchAll(sampleCodeBlock)
		.filter(checkIsValid).length;

	assert(validComponentCount === 1);
}

// Prevent usage of unsafe target='_blank'.
testCatchUnsafeTargetBlank();
function testCatchUnsafeTargetBlank() {
	const sampleCodeBlock = `
const Valid1 = <a target='_blank' rel="noreferrer" href="http://example.com"></a>;
const Valid2 = <a target='_blank' rel="noopener noreferrer" href="http://example.com"></a>;

const Invalid1 = <a target='_blank' href="http://example.com/"></a>;
const Invalid2 = <a target='_blank' href={dynamicLink}></a>;`;

	const checkIsValid = (match) => match.blocks.some((x) => x.includes('noreferrer'));
	const validComponentCount = cgrep`<a $$ target='_blank' $$>`
		.matchAll(sampleCodeBlock)
		.filter(checkIsValid).length;

	assert(validComponentCount === 2);
}

// Enforce event handler naming conventions in JSX.
testEnforceHandlerConvention();
function testEnforceHandlerConvention() {
	const sampleCodeBlock = `
// Valid.
<MyComponent onChange={this.handleChange} />
<MyComponent onChange={this.props.onFoo} />

// Invalid.
<InvalidOne handleChange={this.handleChange} />
<InvalidTwo onChange={this.componentChanged} />`;

	const checkIsValid = (match) => {
		const pieces = match.blocks[1].split('.');
		const variableName = pieces[pieces.length - 1];
		return variableName.startsWith('handle') || variableName.startsWith('on');
	};
	const validHandlerPropNameCount = cgrep`<$a on$$={$$} $$>`
		.matchAll(sampleCodeBlock)
		.filter(checkIsValid).length;

	assert(validHandlerPropNameCount === 2);
}

// Prevent duplicate properties in JSX.
assertMatch(
	cgrep`<$$ $a=$$ $$ $a=$$`,
	`<Button onClick={this.handleClick} text="Hello" onClick={this.deleteUser} />`
);
assertNotMatch(cgrep`<$$ $a=$$ $$ $a=$$`, `<Button onClick={this.handleClick} text="Hello"/>`);

// TODO: Rewrite test suite to actually use describe/it/expect.
describe('cgrep', () => {
	it('runs through cgrep.test.ts', () => {
		expect(true).toBe(true);
	});
});
