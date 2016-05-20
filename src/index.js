import _ from 'lodash';
import appc from 'node-appc';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import 'source-map-support/register';

const exe = appc.subprocess.exe;

/**
 * A list of requird executables used to determine if a directory is a JDK.
 * @type {Array}
 */
const requiredExecutables = ['java', 'javac', 'keytool', 'jarsigner'];

/**
 * Common search paths for the JVM library. This is used only for validating if
 * a directory is a JDK.
 * @type {Object}
 */
const libjvmLocations = {
	linux: [
		'lib/amd64/client/libjvm.so',
		'lib/amd64/server/libjvm.so',
		'lib/i386/client/libjvm.so',
		'lib/i386/server/libjvm.so',
		'jre/lib/amd64/client/libjvm.so',
		'jre/lib/amd64/server/libjvm.so',
		'jre/lib/i386/client/libjvm.so',
		'jre/lib/i386/server/libjvm.so'
	],
	darwin: [
		'jre/lib/server/libjvm.dylib',
		'../Libraries/libjvm.dylib'
	],
	win32: [
		'jre/bin/server/jvm.dll',
		'jre/bin/client/jvm.dll'
	]
};

/**
 * A list of all static paths to check for a JDK. Static paths are those that
 * are derived from the system PATH which cannot change once the app starts.
 * @type {Array}
 */
let staticJDKPaths = null;

/**
 * A cache of all platform specific paths.
 * @type {Array}
 */
let platformPathsCache = null;

/**
 * Detects installed JDKs.
 *
 * @param {Object} [opts] - An object with various params.
 * @param {Boolean} [opts.ignorePlatformPaths=false] - When true, doesn't search
 * well known platform specific paths.
 * @param {Array} [opts.jdkPaths] - One or more paths to known JDKs.
 * @param {Boolan} [opts.gawk] - If true, returns the raw internal Gawk object,
 * otherwise returns a JavaScript object.
 * @returns {Promise}
 */
export function detect(opts = {}) {
	return Promise.resolve()
		.then(() => getJDKPaths(opts.jdkPaths, opts.ignorePlatformPaths))
		.then(paths => appc.detect.scan({ paths, force: opts.force, detectFn: isJDK }))
		.then(results => opts.gawk ? results : results.toJS());
}

/**
 * A handle returned when calling `watch()`. This object exposes a `stop()`
 * method to unwatch all paths specified in the `jdkPaths` parameter.
 *
 * This is not a public class. It should only be instantiated by the `watch()`
 * method.
 *
 * @emits {results} Emits the detection results.
 * @emits {error} Emitted when an error occurs.
 */
class Watcher extends EventEmitter {
	/**
	 * Initializes the Watcher instance.
	 */
	constructor() {
		super();
		this.unwatchers = [];
	}

	/**
	 * Stops all active watchers associated with this handle.
	 */
	stop() {
		let unwatch;
		while (unwatch = this.unwatchers.shift()) {
			unwatch();
		}
	}
}

/**
 * Detects installed JDKs and watches for changes.
 *
 * @param {Object} [opts] - An object with various params.
 * @param {Boolean} [opts.ignorePlatformPaths=false] - When true, doesn't search
 * well known platform specific paths.
 * @param {Array} [opts.jdkPaths] - One or more paths to known JDKs.
 * @param {Boolan} [opts.gawk] - If true, returns the raw internal Gawk object,
 * otherwise returns a JavaScript object.
 * @returns {Promise}
 */
export function watch(opts = {}) {
	const handle = new Watcher;
	let jdkPaths;
	let hash;

	Promise.resolve()
		.then(() => getJDKPaths(opts.jdkPaths, opts.ignorePlatformPaths))
		.then(paths => {
			jdkPaths = paths;
			hash = appc.util.sha1(JSON.stringify(paths));
			return appc.detect.scan({ paths, hash, force: true, detectFn: isJDK });
		})
		.then(results => {
			results.watch(evt => {
				handle.emit('results', opts.gawk ? results : results.toJS());
			});

			for (const dir of jdkPaths) {
				handle.unwatchers.push(appc.fs.watch(dir, _.debounce(evt => {
					appc.detect.scan({ paths: [dir], hash, force: true, detectFn: isJDK })
						.catch(err => {
							handle.stop();
							handle.emit('error', err);
						});
				})));
			}

			handle.emit('results', opts.gawk ? results : results.toJS());
		})
		.catch(err => {
			handle.stop();
			handle.emit('error', err);
		});

	return handle;
}

/**
 * Determines if the specified directory contains a JDK and if so, returns the
 * JDK info.
 *
 * @param {String} dir - The directory to check.
 * @returns {Promise}
 */
function isJDK(dir) {
	// on OS X, the JDK lives in Contents/Home
	if (process.platform === 'darwin') {
		const p = path.join(dir, 'Contents', 'Home');
		if (appc.fs.existsSync(p)) {
			dir = p;
		}
	}

	const libjvms = libjvmLocations[process.platform];
	if (!libjvms || !libjvms.some(p => appc.fs.existsSync(path.resolve(dir, p)))) {
		// if there's no libjvm, then it's not a JDK
		return Promise.resolve();
	}

	let jdkInfo = {
		path: dir,
		version: null,
		build: null,
		architecture: null,
		executables: {}
	};

	if (!requiredExecutables.every(cmd => {
		var p = path.join(dir, 'bin', cmd + exe);
		if (appc.fs.existsSync(p)) {
			jdkInfo.executables[cmd] = fs.realpathSync(p);
			return true;
		}
	})) {
		// missing key executables, not a JDK
		return Promise.resolve();
	}

	return Promise.resolve()
		.then(() => {
			// try the 64-bit version first
			return appc.subprocess.run(jdkInfo.executables.javac, ['-version', '-d64'])
				.then(({ code, stdout, stderr }) => {
					// 64-bit version
					return { output: stderr, arch: '64bit' };
				});
		})
		.catch(err => {
			// try the 32-bit version
			return appc.subprocess.run(jdkInfo.executables.javac, ['-version'])
				.then(({ code, stdout, stderr }) => {
					return { output: stderr, arch: '32bit' };
				});
		})
		.then(details => {
			const m = details.output.match(/javac (.+)_(.+)/);
			if (m) {
				jdkInfo.version = m[1];
				jdkInfo.build = m[2];
			}
			jdkInfo.architecture = details.arch;
			return {
				id: jdkInfo.version + '_' + jdkInfo.build,
				value: jdkInfo
			};
		})
		.catch(err => Promise.resolve());
}

/**
 * Populates the list of static JDK paths based on the JAVA_HOME and system PATH
 * environment variables. These are static because they cannot change once the
 * app is started.
 */
function getStaticJDKPaths() {
	staticJDKPaths = [];

	return Promise
		.all([
			appc.subprocess.which('javac')
				.then(file => {
					const p = path.dirname(path.dirname(fs.realpathSync(file)));
					if (staticJDKPaths.indexOf(p) === -1) {
						staticJDKPaths.push(p);
					}
				})
				.catch(() => Promise.resolve()),

			new Promise((resolve, reject) => {
				const javaHome = process.env.JAVA_HOME;
				if (!javaHome) {
					return resolve();
				}

				fs.stat(javaHome, (err, stat) => {
					if (err || !stat.isDirectory()) {
						return resolve();
					}

					fs.realpath(javaHome, (err, p) => {
						if (!err && staticJDKPaths.indexOf(p) === -1) {
							staticJDKPaths.push(p);
						}
						resolve();
					});
				});
			})
		]);
}

/**
 * Retrieves an array of platform specific paths to search.
 *
 * @param {Array} jdkPaths - An array containing paths to search for JDKs.
 * @param {Boolean} [opts.ignorePlatformPaths=false] - When true, doesn't search
 * well known platform specific paths.
 * @returns {Promise}
 */
function getJDKPaths(jdkPaths, ignorePlatformPaths) {
	const paths = [];

	return Promise.resolve()
		// 1. first get the static paths
		.then(() => {
			if (!staticJDKPaths) {
				return getStaticJDKPaths();
			}
		})
		.then(() => {
			if (staticJDKPaths.length) {
				paths.push.apply(paths, staticJDKPaths);
			}
		})

		// 2. add the platform specific paths
		.then(() => {
			if (!ignorePlatformPaths) {
				return Promise.resolve()
					.then(() => {
						if (!ignorePlatformPaths) {
							if (platformPathsCache) {
								return Promise.resolve(platformPathsCache);
							}

							switch (process.platform) {
								case 'linux':  return findLinuxSearchPaths();
								case 'darwin': return findDarwinSearchPaths();
								case 'win32':  return findWindowsSearchPaths();
							}
						}
						return [];
					})
					.then(platformPaths => {
						platformPathsCache = platformPaths;
						if (platformPaths.length) {
							paths.push.apply(paths, platformPaths);
						}
					});
			}
		})

		// 3. add the jdk paths that were passed in
		.then(() => {
			if (jdkPaths) {
				if (typeof jdkPaths === 'string') {
					jdkPaths = [ jdkPaths ];
				} else if (!Array.isArray(jdkPaths) || jdkPaths.some(i => typeof i !== 'string')) {
					throw new TypeError('Expected jdkPaths to be an array of strings');
				}
			}

			// if there are no paths, then return
			if (!jdkPaths || jdkPaths.length === 0) {
				return;
			}

			return Promise
				.all(jdkPaths.map(p => new Promise((resolve, reject) => {
					if (typeof p !== 'string' || !p) {
						return reject(new TypeError('Invalid path in jdkPaths'));
					}

					fs.stat(p, (err, stat) => {
						if (err) {
							// path does not exist, but maybe it will
							return resolve(p);
						}

						if (!stat.isDirectory()) {
							// path doesn't exist or not a directory, move along
							return resolve();
						}

						// path exists, get the real path before we add it
						fs.realpath(p, (err, dir) => resolve(err ? null : dir));
					});
				})))
				.then(jdkPaths => paths.push.apply(paths, jdkPaths));
		})

		// 4. clean up the list of paths
		.then(() => appc.util.unique(paths).sort());
}

/**
 * Returns an array of well known JDK paths on Linux.
 *
 * @returns {Promise}
 */
function findLinuxSearchPaths() {
	return Promise.resolve([
		'/usr/lib/jvm'
	]);
}

/**
* Returns an array of well known JDK paths on OS X.
 *
 * @returns {Promise}
 */
function findDarwinSearchPaths() {
	return Promise.resolve([
		'/Library/Java/JavaVirtualMachines',
		'/System/Library/Java/JavaVirtualMachines'
	]);
}

/**
 * Returns an array of well known JDK paths on Windows.
 *
 * @returns {Promise}
 */
function findWindowsSearchPaths() {
	const Winreg = require('winreg');

	const searchWindowsRegistry = key => {
		return new Promise((resolve, reject) => {
			new Winreg({ hive: Winreg.HKLM, key })
				.get('CurrentVersion', (err, item) => {
					const currentVersion = !err && item.value;
					if (!currentVersion) {
						return resolve();
					}

					new Winreg({ hive: Winreg.HKLM, key: key + '\\' + currentVersion })
						.get('JavaHome', (err, item) => {
							if (!err && item.value) {
								resolve(item.value);
							} else {
								resolve();
							}
						});
				});
		});
	};

	return Promise.all([
		searchWindowsRegistry('\\Software\\JavaSoft\\Java Development Kit'),
		searchWindowsRegistry('\\Software\\Wow6432Node\\JavaSoft\\Java Development Kit')
	]);
}

/**
 * Utility function to reset all global state. This is primarily for testing
 * purposes.
 */
export function reset() {
	appc.detect.resetCache();
	staticJDKPaths = null;
	platformPathsCache = null;
}
