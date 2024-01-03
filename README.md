# cgrep

cgrep is an npm package for writing project checks with regex.

It includes

- A command, `yarn cgrep`, which runs all project checks against all project files.
- An extended regex grammar for finding code patterns.

```bash
yarn add -D cgrep
```

# command

```
> yarn cgrep -h
Usage: cgrep [options]

Checks project files against cgrep rules.

Options:
  -V, --version         output the version number
  -s, --staged          only check git staged files
  -d, --debug           print debug information
  -p, --project <path>  path to tsconfig.json
  -g, --glob <pattern>  only check files matching glob pattern
  --cwd <path>          set the current working directory
  -h, --help            display help for command
```

On run, `cgrep` will

1. Load all checks from `cgrep.config.[ts,js]` in the project root.
    - All publicly exported functions will be registered as a check. For example,
        ```typescript
        import { cgrep, CGrepCheckArgs } from 'cgrep';
        export function avoidFooModule({ underline }: CGrepCheckArgs) {
            underline(
                cgrep`import $$ from 'foo'`,
                "Do not use foo module, prefer bar.",
                "warn");
        }
        ```
1. Each check will be run against all project files. `.gitignore` is respected. If a check returns boolean `false` or the string `fail`, the `cgrep` command will have a failure exit code.
    - Each check is passed the following args as an object:
        ```typescript
        /** Eg 'src/components/foo.js'. Relative posix path format. */
        filePath: string;

        /** Eg 'example.js' */
        fileName: string;

        /** Eg '.js' */
        fileExtension: string;

        /** Eg 'console.log("hello world");' */
        fileContents: string;

        /** Function to underline a string or regexp in `fileContents` and log it to console. */
        underline: (
            regexOrText: RegExp | string,
            message: string,
            alert?: 'error' | 'warn' | 'info'
        ) => void;
        ```

`cgrep` can be plugged in as part of a lint step in CI:CD or as a git commit hook.

# module

`cgrep` exports typings and one string interpolation function, `cgrep`.

`cgrep` returns a standard `RegExp` object with two extra functions, `matchFirst` and `matchAll`. You can think of it as regex specifically for JavaScript code.

`$a`: match any variable.  
`$1`: match any literal.  
`$@`: match any operator.  
`$#`: match any keyword.  
`$$`: match any block (non-greedy).  
`$$$`: match any block (greedy).  
`REGEX()`: match any regex.  

Let's look at some examples.

```
cgrep`if ($a == $b) { return $c; }`
    matches:
        1. if (foo == bar) {
            return baz;
        }
        2. if (apple==orange){return banana;}
cgrep`$1 + $2 + $3`
    matches:
        1. 44 + "hello world" + 3.14159
        2. 1 + 2 + 3
        3. 1 + 1 + 1
cgrep`if (a $@ b)`
    matches:
        1. if (a + b)
        2. if(a-b)
        3. if(a   <  b)
cgrep`$# (true)`
    matches:
        1. while (true)
        2. if ( true )
cgrep`do { $$ } while(true)`
    matches
        1. do {
            console.log(foo);
            log("cool");
        }   while  (true)
        2. do {} while(true)
cgrep`REGEX(3+9+2*) 5 + 5`
    matches
        1. 392225+5
```

There is a live cgrep expression playground [here](https://itslit.fr/).  
You can also view the test suite for more examples.