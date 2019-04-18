import * as webpack from 'webpack';
import * as path from 'path';

function configure(): webpack.Configuration {
    const configuration: webpack.Configuration = {
        entry: './src/index.ts',
        output: {
            path: path.resolve(__dirname, 'dist'),
            filename: 'index.js',
            library: 'stackino_due_plugin_router5',
            libraryTarget: 'umd'
        },
        module: {
            rules: [
				{ test: /\.tsx?$/, use: 'eslint-loader', exclude: /node_modules/, enforce: 'pre' },
				{ test: /\.tsx?$/, use: 'ts-loader', exclude: /node_modules/ },
            ],
        },
        resolve: {
			extensions: ['.tsx', '.ts', '.js'],
        },
        externals: {
            '@stackino/due': '@stackino/due',
            'mobx': 'mobx',
            'router5': 'router5',
            'router5-plugin-browser': 'router5-plugin-browser',
            'tslib': 'tslib'
        },
    };

    return configuration;
}

module.exports = configure();