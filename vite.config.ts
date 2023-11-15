import { defineConfig } from 'vite';
import { externalizeDeps } from 'vite-plugin-externalize-deps';
import typescript from '@rollup/plugin-typescript';

export default defineConfig({
    plugins: [
        externalizeDeps(),
    ],
    build: {
        target: 'esnext',
        lib: {
            entry: 'src/index.ts',
            name: 'cgrep',
            fileName: 'cgrep'
        },
        rollupOptions: {
            treeshake: 'smallest',
            plugins: [
                typescript({
                    target: 'es2020',
                    rootDir: 'src',
                    declaration: true,
                    declarationDir: 'dist',
                    exclude: 'node_modules/**',
                    allowSyntheticDefaultImports: true,
                }),
            ]
        }
    }
});
