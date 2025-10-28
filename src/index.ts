import type { Plugin } from 'esbuild'
import { existsSync, readdirSync, statSync, type ObjectEncodingOptions } from 'fs'
import { dirname, extname, join, posix, relative, resolve, sep } from 'path'

interface RecursiveDirEntry {
	/** The file's name with extension */
	name: string
	/** The file's extension */
	ext: string
	/** The file's absolute path */
	path: string
	/** The parent directory's absolute path */
	parentPath: string
	/** The file's path relative to the directory being recursed */
	localPath: string
}

interface RecursiveReadDirSyncOptions {
	encoding?: ObjectEncodingOptions['encoding']
	maxDepth?: number
	filter?: (file: RecursiveDirEntry) => boolean
}

/**
 * Recursively reads a directory and returns an array of file information.
 * @param dir The directory to read.
 * @param encoding The encoding to use when reading file names.
 * @param maxDepth The maximum depth to recurse into subdirectories.
 * @returns An array of file information objects.
 */
function recursiveReadDirSync(
	dir: string,
	{ encoding = 'utf-8', maxDepth = 200, filter }: RecursiveReadDirSyncOptions
): RecursiveDirEntry[] {
	const files: RecursiveDirEntry[] = []

	function recurse(localDir: string, depth = 0) {
		// If a local index is found, it is imported and the rest of the directory is ignored.
		const indexPath = join(localDir, 'index.ts')
		if (existsSync(indexPath)) {
			const absolutePath = resolve(localDir, 'index.ts')
			files.push({
				name: 'index',
				ext: '.ts',
				path: absolutePath,
				parentPath: localDir,
				localPath: relative(dir, absolutePath),
			})
			return
		}

		readdirSync(localDir, { encoding, withFileTypes: true }).forEach(dirEntry => {
			const absolutePath = join(localDir, dirEntry.name)
			if (dirEntry.isDirectory() && depth <= maxDepth) {
				recurse(absolutePath, depth + 1)
			} else {
				const fileEntry: RecursiveDirEntry = {
					name: dirEntry.name,
					ext: extname(dirEntry.name),
					path: absolutePath,
					parentPath: dirname(absolutePath),
					localPath: relative(dir, absolutePath),
				}
				if (!!filter && !filter(fileEntry)) return
				files.push(fileEntry)
			}
		})
	}
	recurse(dir)

	return files
}

function normalizePathToPosix(path: string) {
	return path.replaceAll(sep, posix.sep)
}

const IMPORT_REGEX = /(.+)(\/\*\*?)(?:{(\..+)})?$/

/**
 * A plugin for importing all files in a folder without manually updating an index file.
 *
 * Use the `/*` suffix to import all files in a folder.
 *
 * Use the `/**` suffix to import all files in a folder and it's subdirectories.
 *
 * Optionally, you can specify a set of file extensions to filter by using curly braces. (Includes .js and .ts by default)
 *
 * e.g. `/*{.ts|.js}`
 *
 * NOTE - If you're using a glob plugin, this plugin should be executed first.
 */
export default function importFolder(): Plugin {
	const plugin: Plugin = {
		name: 'import-folder',

		setup: build => {
			build.onResolve({ filter: IMPORT_REGEX, namespace: 'file' }, args => {
				const [_, path, mode, extensions] = IMPORT_REGEX.exec(args.path)!

				const fullPath = normalizePathToPosix(join(args.resolveDir, path))

				const stat = statSync(fullPath)
				if (!stat.isDirectory()) {
					return {
						errors: [
							{
								text: `The path "${fullPath}" is not a directory.`,
								location: { file: args.importer },
							},
						],
					}
				}

				return {
					namespace: 'import-folder',
					path: fullPath,
					pluginData: {
						recursive: mode === '/**',
						importer: args.importer,
						extensions,
					},
				}
			})

			build.onLoad({ filter: /.+/, namespace: 'import-folder' }, args => {
				let files: RecursiveDirEntry[]

				const filteredExtensions = args.pluginData.extensions
					? args.pluginData.extensions.split('|')
					: ['.js', '.ts']

				const filter: RecursiveReadDirSyncOptions['filter'] = file => {
					return filteredExtensions.includes(file.ext)
				}

				if (args.pluginData.recursive) {
					files = recursiveReadDirSync(args.path, { encoding: 'utf-8', filter })
				} else {
					files = recursiveReadDirSync(args.path, {
						encoding: 'utf-8',
						filter,
						maxDepth: 0,
					})
				}

				const contents = files
					.map(file => `import './${normalizePathToPosix(file.localPath)}';`)
					.join('\n')

				return {
					loader: 'js',
					contents,
					watchFiles: files.map(file => join(file.parentPath, file.name)),
					resolveDir: args.path,
				}
			})
		},
	}
	return plugin
}
