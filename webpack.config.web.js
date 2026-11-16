const HtmlWebpackPlugin = require("html-webpack-plugin")
const NodePolyfillPlugin = require("node-polyfill-webpack-plugin")
const { GriffelPlugin } = require("@griffel/webpack-plugin")
const MiniCssExtractPlugin = require("mini-css-extract-plugin")
const path = require("path")

const SOURCE_DIR = path.resolve(__dirname, "src")

// Browser build of the renderer. Kept separate from webpack.config.js so the
// Electron build keeps exactly three bundles and the same output directory.
module.exports = {
    mode: "production",
    stats: "minimal",
    entry: "./src/index.web.tsx",
    target: "web",
    devtool: "source-map",
    performance: {
        hints: false,
    },
    module: {
        rules: [
            {
                test: /\.(js|ts|tsx)$/,
                include: [SOURCE_DIR, /node_modules[\\/]@fluentui/],
                use: {
                    loader: "@griffel/webpack-plugin/loader",
                },
            },
            {
                test: /\.ts(x?)$/,
                include: SOURCE_DIR,
                resolve: {
                    extensions: [".ts", ".tsx", ".js"],
                },
                use: {
                    loader: "ts-loader",
                },
            },
            {
                test: /\.css$/,
                use: [MiniCssExtractPlugin.loader, "css-loader"],
            },
        ],
    },
    output: {
        path: path.resolve(__dirname, "dist-web"),
        // Content-hashed names: Cloudflare caches these for hours, so a stable
        // name would keep serving the previous build after every deploy.
        filename: "[name].[contenthash:8].js",
        chunkFilename: "[name].[contenthash:8].chunk.js",
        publicPath: "/",
        clean: true,
    },
    plugins: [
        new NodePolyfillPlugin({
            additionalAliases: ["process"],
            excludeAliases: ["Buffer"],
        }),
        new HtmlWebpackPlugin({
            template: "./src/index.html",
        }),
        new MiniCssExtractPlugin({
            filename: "[name].[contenthash:8].css",
        }),
        new GriffelPlugin(),
    ],
}
